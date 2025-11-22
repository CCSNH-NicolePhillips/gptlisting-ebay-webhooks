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
const CHUNK_SIZE = 8; // Process 8 images per chunk
const PARALLEL_CHUNKS = 3; // Process 3 chunks concurrently
const LOCK_TTL = 60; // Lock timeout in seconds

// Parallel processing helper (borrowed from analyze-core.ts)
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current], current);
    }
  }

  const workers = new Array(Math.min(limit, items.length)).fill(0).map(() => worker());
  await Promise.all(workers);
  return results;
}

// Redis lock helpers
async function acquireLock(key: string, ttl: number): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!url || !token) return false;

  // Use SET NX (set if not exists)
  const response = await fetch(`${url}/set/${encodeURIComponent(key)}/locked/EX/${ttl}/NX`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) return false;
  const data = await response.json();
  return data.result === "OK";
}

async function releaseLock(key: string): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!url || !token) return;

  await fetch(`${url}/del/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

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
    
    // Determine which chunks to process in parallel
    const remainingImages = totalImages - processedCount;
    const chunksToProcess = Math.min(PARALLEL_CHUNKS, Math.ceil(remainingImages / CHUNK_SIZE));
    
    const chunkRanges: Array<{ start: number; end: number; paths: string[] }> = [];
    for (let i = 0; i < chunksToProcess; i++) {
      const chunkStart = processedCount + (i * CHUNK_SIZE);
      const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, totalImages);
      if (chunkStart < totalImages) {
        chunkRanges.push({
          start: chunkStart,
          end: chunkEnd,
          paths: job.dropboxPaths.slice(chunkStart, chunkEnd),
        });
      }
    }

    console.log(`[pairing-v2-processor] Processing ${chunkRanges.length} chunks in parallel (${processedCount}/${totalImages} done)...`);

    // Process chunks in parallel with locks to prevent duplicates
    const { classifyImagesBatch } = await import("../../src/smartdrafts/pairing-v2-core.js");
    
    const chunkResults = await mapLimit(chunkRanges, PARALLEL_CHUNKS, async (chunkRange) => {
      const lockKey = `${JOB_KEY_PREFIX}${jobId}:lock:${chunkRange.start}`;
      
      // Try to acquire lock for this chunk
      const lockAcquired = await acquireLock(lockKey, LOCK_TTL);
      if (!lockAcquired) {
        console.log(`[pairing-v2-processor] Chunk ${chunkRange.start}-${chunkRange.end} already processing (locked), skipping`);
        return null;
      }

      try {
        console.log(`[pairing-v2-processor] Processing chunk ${chunkRange.start}-${chunkRange.end}...`);
        
        // Create temp directory for this chunk
        const chunkWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), `pairing-v2-${chunkRange.start}-`));

        try {
          // Download images from Dropbox for this chunk
          const localPaths: string[] = [];
          for (const dropboxPath of chunkRange.paths) {
            const filename = path.basename(dropboxPath);
            const localPath = path.join(chunkWorkDir, filename);

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

          console.log(`[pairing-v2-processor] Chunk ${chunkRange.start}-${chunkRange.end}: Downloaded ${localPaths.length} images`);

          // Classify this chunk
          const chunkClassifications = await classifyImagesBatch(localPaths);
          console.log(`[pairing-v2-processor] Chunk ${chunkRange.start}-${chunkRange.end}: Classified ${chunkClassifications.length} images`);

          return chunkClassifications;
        } finally {
          // Clean up temp directory for this chunk
          fs.rmSync(chunkWorkDir, { recursive: true, force: true });
        }
      } finally {
        // Release lock
        await releaseLock(lockKey);
      }
    });

    // Filter out null results (skipped due to locks) and flatten
    const newClassifications = chunkResults.filter((c): c is any[] => c !== null).flat();
    
    console.log(`[pairing-v2-processor] Parallel processing complete: ${newClassifications.length} new classifications`);

    // Accumulate classifications
    job.classifications = job.classifications || [];
    job.classifications.push(...newClassifications);
    job.processedCount = processedCount + newClassifications.length;
    job.updatedAt = Date.now();

    const isLastChunk = job.processedCount >= totalImages;

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
          progress: `${job.processedCount}/${totalImages} images classified`,
          chunksProcessed: chunkRanges.length,
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
