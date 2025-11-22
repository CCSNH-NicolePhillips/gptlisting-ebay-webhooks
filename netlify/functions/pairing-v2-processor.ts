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

    // Update status to processing
    job.status = "processing";
    job.updatedAt = Date.now();
    await redisSet(key, JSON.stringify(job), JOB_TTL);

    console.log(`[pairing-v2-processor] Processing ${job.dropboxPaths.length} images...`);

    // Create temp directory for downloads
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-v2-"));

    // Download images from Dropbox
    const localPaths: string[] = [];
    for (const dropboxPath of job.dropboxPaths) {
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

    // Run the three-stage pairing pipeline
    console.log(`[pairing-v2-processor] Running pairing pipeline...`);
    const result = await runNewTwoStagePipeline(localPaths);

    // Clean up temp directory
    if (workDir) {
      fs.rmSync(workDir, { recursive: true, force: true });
      workDir = null;
    }

    // Convert local paths back to basenames for result
    const basenamePairs = result.pairs.map(pair => ({
      ...pair,
      front: path.basename(pair.front),
      back: path.basename(pair.back),
    }));

    const basenameUnpaired = result.unpaired.map(item => ({
      ...item,
      imagePath: path.basename(item.imagePath),
    }));

    const finalResult: PairingResult = {
      pairs: basenamePairs,
      unpaired: basenameUnpaired,
      metrics: result.metrics,
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
      body: JSON.stringify({ ok: true, jobId, status: "completed" }),
    };
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
