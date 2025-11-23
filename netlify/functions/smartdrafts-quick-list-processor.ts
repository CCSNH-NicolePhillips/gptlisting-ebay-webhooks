/**
 * Quick List Background Processor
 * 
 * Processes Quick List jobs: Pairing-v2 → Trigger Draft Creation
 */

import { Handler } from "@netlify/functions";
import { runNewTwoStagePipeline } from "../../src/smartdrafts/pairing-v2-core.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Redis helpers
async function redisSet(key: string, value: string, exSeconds: number): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!url || !token) {
    throw new Error("Redis not configured");
  }

  const response = await fetch(`${url}/setex/${encodeURIComponent(key)}/${exSeconds}/${encodeURIComponent(value)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Redis SETEX failed: ${response.status}`);
  }
}

async function redisGet(key: string): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!url || !token) {
    throw new Error("Redis not configured");
  }

  const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Redis GET failed: ${response.status}`);
  }

  const data = await response.json();
  return data.result || null;
}

interface QuickListJob {
  jobId: string;
  userId: string;
  status: "pending" | "pairing" | "creating-drafts" | "completed" | "failed";
  scanJobId: string;
  
  currentStage: "pairing" | "drafts" | "complete";
  pairingResult?: {
    pairs: Array<{ front: string; back: string; frontUrl: string; backUrl: string; brand?: string | null; title?: string | null; product?: string | null }>;
    unpaired: Array<{ imagePath: string; reason: string }>;
  };
  
  drafts?: any[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const JOB_TTL = 3600;
const JOB_KEY_PREFIX = "quick-list-job:";
const SCAN_JOB_PREFIX = "job:";
const LOCK_TTL = 600; // 10 minutes

async function acquireLock(lockKey: string): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!url || !token) {
    throw new Error("Redis not configured");
  }

  const response = await fetch(
    `${url}/set/${encodeURIComponent(lockKey)}/locked/EX/${LOCK_TTL}/NX`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!response.ok) {
    throw new Error(`Failed to acquire lock: ${response.status}`);
  }

  const data = await response.json();
  return data.result === "OK";
}

async function releaseLock(lockKey: string): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!url || !token) return;

  await fetch(`${url}/del/${encodeURIComponent(lockKey)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Download image from URL to local filesystem
async function downloadImage(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }
  
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(buffer));
}

export const handler: Handler = async (event) => {
  const jobId = event.queryStringParameters?.jobId;
  if (!jobId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing jobId" }),
    };
  }

  const key = `${JOB_KEY_PREFIX}${jobId}`;
  const lockKey = `${key}:lock`;

  try {
    // Try to acquire lock
    const acquired = await acquireLock(lockKey);
    if (!acquired) {
      console.log(`[quick-list-processor] Job ${jobId} already processing (locked), skipping`);
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, message: "Already processing" }),
      };
    }

    try {
      console.log(`[quick-list-processor] Processing job ${jobId}...`);

      const data = await redisGet(key);
      if (!data) {
        return {
          statusCode: 404,
          body: JSON.stringify({ error: "Job not found" }),
        };
      }

      const job: QuickListJob = JSON.parse(data);

      // Only process if pending
      if (job.status !== "pending") {
        console.log(`[quick-list-processor] Job ${jobId} already ${job.status}, skipping`);
        return {
          statusCode: 200,
          body: JSON.stringify({ ok: true, status: job.status }),
        };
      }

      // Fetch scan job to get image URLs
      const scanJobData = await redisGet(`${SCAN_JOB_PREFIX}${job.userId}:${job.scanJobId}`);
      if (!scanJobData) {
        throw new Error(`Scan job ${job.scanJobId} not found`);
      }

      const scanJob = JSON.parse(scanJobData);
      const stagedUrls: string[] = scanJob.stagedUrls || [];

      if (stagedUrls.length === 0) {
        throw new Error("Scan job has no staged image URLs");
      }

      console.log(`[quick-list-processor] Found ${stagedUrls.length} images from scan job`);

      // Update job status: starting pairing
      job.status = "pairing";
      job.currentStage = "pairing";
      job.updatedAt = Date.now();
      await redisSet(key, JSON.stringify(job), JOB_TTL);

      // Create temp directory for processing
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `quick-list-${jobId}-`));
      
      try {
        // Download all images
        console.log(`[quick-list-processor] Downloading ${stagedUrls.length} images...`);
        const imagePaths: string[] = [];
        
        for (let i = 0; i < stagedUrls.length; i++) {
          const url = stagedUrls[i];
          const filename = path.basename(new URL(url).pathname);
          const localPath = path.join(workDir, filename);
          
          await downloadImage(url, localPath);
          imagePaths.push(localPath);
        }

        console.log(`[quick-list-processor] Downloaded ${imagePaths.length} images, running pairing-v2...`);

        // Run pairing-v2 pipeline
        const pairingResult = await runNewTwoStagePipeline(imagePaths);

        console.log(`[quick-list-processor] Pairing complete: ${pairingResult.pairs.length} pairs`);

        // Create shareable URLs for pairs (using original staged URLs)
        const urlMap = new Map<string, string>();
        imagePaths.forEach((localPath, index) => {
          const filename = path.basename(localPath);
          urlMap.set(filename, stagedUrls[index]);
        });

        const pairsWithUrls = pairingResult.pairs.map(pair => ({
          front: pair.front,
          back: pair.back,
          frontUrl: urlMap.get(pair.front) || '',
          backUrl: urlMap.get(pair.back) || '',
          brand: pair.brand,
          title: pair.title,
          product: pair.product,
        }));

        // Update job: pairing complete, starting draft creation
        job.status = "creating-drafts";
        job.currentStage = "drafts";
        job.pairingResult = {
          pairs: pairsWithUrls,
          unpaired: pairingResult.unpaired,
        };
        job.updatedAt = Date.now();
        await redisSet(key, JSON.stringify(job), JOB_TTL);

        console.log(`[quick-list-processor] Starting draft creation for ${pairsWithUrls.length} products...`);

        // Convert pairs to products format
        const products = pairsWithUrls.map((pair, index) => ({
          productId: `product-${index + 1}`,
          brand: pair.brand || null,
          title: pair.title || null,
          product: pair.product || null,
          heroDisplayUrl: pair.frontUrl,
          backDisplayUrl: pair.backUrl,
        }));

        // Trigger draft creation background job directly (service-to-service call)
        const baseUrl = process.env.APP_URL || 'https://ebaywebhooks.netlify.app';
        const draftBgUrl = `${baseUrl}/.netlify/functions/smartdrafts-create-drafts-background`;
        
        // Generate job ID for draft creation
        const draftJobId = `draft-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        const draftResponse = await fetch(draftBgUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            jobId: draftJobId,
            userId: job.userId,
            products 
          }),
        });

        if (!draftResponse.ok) {
          const errorText = await draftResponse.text();
          throw new Error(`Failed to start draft creation: ${draftResponse.status} - ${errorText}`);
        }

        console.log(`[quick-list-processor] Draft creation job started: ${draftJobId}`);

        // Poll for draft creation completion (max 2 minutes)
        let draftAttempts = 0;
        let drafts: any[] = [];
        let draftComplete = false;

        while (draftAttempts++ < 80 && !draftComplete) {
          await new Promise(resolve => setTimeout(resolve, 1500));

          const statusUrl = `${baseUrl}/.netlify/functions/smartdrafts-create-drafts-status?jobId=${encodeURIComponent(draftJobId)}`;
          const statusResponse = await fetch(statusUrl);

          if (!statusResponse.ok) {
            console.error(`[quick-list-processor] Failed to check draft status: ${statusResponse.status}`);
            continue;
          }

          const statusData = await statusResponse.json();
          const draftJobData = statusData.job || {};

          if (draftJobData.state === 'complete') {
            draftComplete = true;
            drafts = draftJobData.drafts || [];
            console.log(`[quick-list-processor] Draft creation complete: ${drafts.length} drafts`);
          } else if (draftJobData.state === 'failed') {
            throw new Error(draftJobData.error || 'Draft creation failed');
          }
        }

        if (!draftComplete) {
          throw new Error('Draft creation timed out after 2 minutes');
        }

        console.log(`[quick-list-processor] Created ${drafts.length} drafts`);

        // Update job: complete
        job.status = "completed";
        job.currentStage = "complete";
        job.drafts = drafts;
        job.updatedAt = Date.now();
        await redisSet(key, JSON.stringify(job), JOB_TTL);

        console.log(`[quick-list-processor] ✅ Job complete: ${drafts.length} drafts created`);

        return {
          statusCode: 200,
          body: JSON.stringify({ 
            ok: true, 
            jobId, 
            status: "completed",
            pairs: pairsWithUrls.length,
            drafts: drafts.length,
          }),
        };
      } finally {
        // Clean up temp directory
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    } finally {
      // Release lock
      await releaseLock(lockKey);
    }
  } catch (err) {
    console.error(`[quick-list-processor] Job ${jobId} failed:`, err);

    // Update job with error
    const errorData = await redisGet(key);
    if (errorData) {
      const job: QuickListJob = JSON.parse(errorData);
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      job.updatedAt = Date.now();
      await redisSet(key, JSON.stringify(job), JOB_TTL);
    }

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
