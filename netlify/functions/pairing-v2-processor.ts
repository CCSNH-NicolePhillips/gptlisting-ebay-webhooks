/**
 * Background processor for pairing-v2 jobs
 * This function is called directly by the scheduler to process a specific job
 */

import { Handler } from "@netlify/functions";
import { getPairingV2JobStatus } from "../../src/lib/pairingV2Jobs.js";
import { runNewTwoStagePipeline, type PairingResult } from "../../src/smartdrafts/pairing-v2-core.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Redis helpers
async function redisSet(key: string, value: string, exSeconds: number): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!url || !token) {
    throw new Error("UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not configured");
  }

  const response = await fetch(`${url}/setex/${encodeURIComponent(key)}/${exSeconds}/${encodeURIComponent(value)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Redis SETEX failed: ${response.status} ${await response.text()}`);
  }
}

async function redisGet(key: string): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!url || !token) {
    throw new Error("UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not configured");
  }

  const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Redis GET failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return data.result;
}

const JOB_TTL = 3600;
const JOB_KEY_PREFIX = "pairing-v2-job:";
const CHUNK_SIZE = 8; // Process 8 images per invocation to stay under 26s timeout

export const handler: Handler = async (event) => {
  const jobId = event.queryStringParameters?.jobId;

  if (!jobId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing jobId parameter" }),
    };
  }

  console.log(`[pairing-v2-processor] Processing job ${jobId}...`);

  const key = `${JOB_KEY_PREFIX}${jobId}`;
  let workDir: string | null = null;

  try {
    // Get job
    const data = await redisGet(key);
    if (!data) {
      throw new Error(`Job ${jobId} not found`);
    }

    const job: any = JSON.parse(data);

    // Update status to processing if first chunk
    if (job.status === "pending") {
      job.status = "processing";
      job.updatedAt = Date.now();
      await redisSet(key, JSON.stringify(job), JOB_TTL);
    }

    const totalImages = job.dropboxPaths.length;
    const processedCount = job.processedCount || 0;
    
    // Determine which chunk to process
    const chunkStart = processedCount;
    const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, totalImages);
    const chunk = job.dropboxPaths.slice(chunkStart, chunkEnd);
    const isLastChunk = chunkEnd >= totalImages;

    console.log(`[pairing-v2-processor] Processing chunk ${chunkStart}-${chunkEnd} of ${totalImages} images (${chunk.length} in this batch)...`);

    // Create temp directory for downloads
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-v2-"));

    // Download images from Dropbox for this chunk
    const localPaths: string[] = [];
    for (const dropboxPath of chunk) {
      const filename = path.basename(dropboxPath);
      const localPath = path.join(workDir, filename);

      console.log(`[pairing-v2-processor] Downloading ${dropboxPath}...`);

      // Download image from Dropbox
      const response = await fetch("https://content.dropboxapi.com/2/files/download", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${job.accessToken}`,
          "Dropbox-API-Arg": JSON.stringify({ path: dropboxPath }),
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to download ${dropboxPath}: ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(localPath, buffer);
      localPaths.push(localPath);
    }

    console.log(`[pairing-v2-processor] Downloaded ${localPaths.length} images to ${workDir}`);

    // Classify this chunk using Stage 1 only
    console.log(`[pairing-v2-processor] Classifying chunk...`);
    
    // Import classification function from pairing-v2-core
    const { classifyImagesBatch } = await import("../../src/smartdrafts/pairing-v2-core.js");
    const chunkClassifications = await classifyImagesBatch(localPaths);

    // Clean up temp directory
    if (workDir) {
      fs.rmSync(workDir, { recursive: true, force: true });
      workDir = null;
    }

    // Accumulate classifications
    job.classifications = job.classifications || [];
    job.classifications.push(...chunkClassifications);
    job.processedCount = chunkEnd;
    job.updatedAt = Date.now();

    console.log(`[pairing-v2-processor] Chunk complete. Total classified: ${job.classifications.length}/${totalImages}`);

    if (isLastChunk) {
      // All images classified - now run pairing and verification
      console.log(`[pairing-v2-processor] All images classified. Running pairing pipeline...`);
      
      const { pairFromClassifications, verifyPairs } = await import("../../src/smartdrafts/pairing-v2-core.js");
      
      // Stage 2: Pair from classifications
      const pairing = await pairFromClassifications(job.classifications);
      
      // Stage 3: Verify pairs
      const verification = await verifyPairs(job.classifications, pairing);
      
      const acceptedPairs = verification.verifiedPairs.filter((p: any) => p.status === 'accepted');
      const rejectedPairs = verification.verifiedPairs.filter((p: any) => p.status === 'rejected');

      console.log(`[pairing-v2-processor] Verification complete: ${acceptedPairs.length} accepted, ${rejectedPairs.length} rejected`);

      // Build final result with basenames
      const basenamePairs = acceptedPairs.map((pair: any) => ({
        front: path.basename(pair.front),
        back: path.basename(pair.back),
        confidence: pair.confidence,
        brand: null,
        product: null,
      }));

      const basenameSingletons = pairing.unpaired.map((item: any) => ({
        imagePath: item.filename,
        reason: item.reason,
        needsReview: item.needsReview,
      }));

      // Add rejected pairs to unpaired
      rejectedPairs.forEach((pair: any) => {
        basenameSingletons.push({
          imagePath: path.basename(pair.front),
          reason: `Rejected pair: ${pair.issues?.join(', ')}`,
          needsReview: true,
        });
        basenameSingletons.push({
          imagePath: path.basename(pair.back),
          reason: `Rejected pair: ${pair.issues?.join(', ')}`,
          needsReview: true,
        });
      });

      const finalResult = {
        pairs: basenamePairs,
        unpaired: basenameSingletons,
        metrics: {
          totals: {
            images: totalImages,
            fronts: job.classifications.filter((c: any) => c.panel === 'front').length,
            backs: job.classifications.filter((c: any) => c.panel === 'back' || c.panel === 'side').length,
            candidates: basenamePairs.length,
            autoPairs: 0,
            modelPairs: basenamePairs.length,
            globalPairs: 0,
            singletons: basenameSingletons.length,
          },
          byBrand: {},
          reasons: {},
        },
      };

      // Update job with result
      job.status = "completed";
      job.result = finalResult;
      job.updatedAt = Date.now();
      // Clear access token from completed job for security
      job.accessToken = "";
      await redisSet(key, JSON.stringify(job), JOB_TTL);

      console.log(`[pairing-v2-processor] Job ${jobId} completed: ${finalResult.pairs.length} pairs`);

      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, jobId, status: "completed", pairs: finalResult.pairs.length }),
      };
    } else {
      // More chunks to process - save progress
      await redisSet(key, JSON.stringify(job), JOB_TTL);

      console.log(`[pairing-v2-processor] Chunk saved. Client should trigger next chunk.`);

      return {
        statusCode: 200,
        body: JSON.stringify({ 
          ok: true, 
          jobId, 
          status: "processing", 
          progress: `${chunkEnd}/${totalImages} images classified`,
          needsNextChunk: true // Tell client to trigger next chunk
        }),
      };
    }
  } catch (error) {
    console.error(`[pairing-v2-processor] Job ${jobId} failed:`, error);

    // Clean up temp directory on error
    if (workDir) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.error(`[pairing-v2-processor] Failed to cleanup ${workDir}:`, cleanupErr);
      }
    }

    // Update job with error
    const data = await redisGet(key);
    if (data) {
      const job: any = JSON.parse(data);
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = Date.now();
      // Clear access token from failed job for security
      job.accessToken = "";
      await redisSet(key, JSON.stringify(job), JOB_TTL);
    }

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
};
