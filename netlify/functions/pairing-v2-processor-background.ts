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

// ImageClassificationV2 type for proper typing
interface ImageClassificationV2 {
  filename: string;
  kind: 'product' | 'non-product';
  panel: 'front' | 'back' | 'side' | 'unclear';
  brand: string | null;
  productName: string | null;
  packageType: 'bottle' | 'jar' | 'tub' | 'pouch' | 'box' | 'sachet' | 'unknown';
  keyText: string[];
  colorSignature: string[];
  layoutSignature: string;
  confidence: number;
}

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
const LOCK_TTL = 120; // 2 minutes for full pipeline

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

    const uploadMethod = job.uploadMethod || "dropbox"; // Default to dropbox for backward compat
    const totalImages = (job.dropboxPaths || job.stagedUrls || []).length;
    const processedCount = job.processedCount || 0;
    
    // Check if already processed
    if (processedCount >= totalImages) {
      console.log(`[pairing-v2-processor] Job already complete: ${processedCount}/${totalImages}`);
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, jobId, status: job.status }),
      };
    }

    // Acquire global lock for this job
    const lockKey = `${JOB_KEY_PREFIX}${jobId}:lock`;
    const lockAcquired = await acquireLock(lockKey, LOCK_TTL);
    if (!lockAcquired) {
      console.log(`[pairing-v2-processor] Job ${jobId} already processing (locked), skipping`);
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, jobId, status: "processing", message: "Already processing" }),
      };
    }

    try {
      console.log(`[pairing-v2-processor] Downloading all ${totalImages} images (${uploadMethod} mode)...`);
      
      // Create temp directory
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `pairing-v2-${jobId}-`));

      try {
        // Download all images based on upload method
        const localPaths: string[] = [];
        
        if (uploadMethod === "dropbox") {
          // Dropbox mode: Download from Dropbox API
          for (const dropboxPath of job.dropboxPaths) {
            const filename = path.basename(dropboxPath);
            const localPath = path.join(workDir, filename);

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
        } else {
          // Local mode: Download from staged URLs
          for (const stagedUrl of job.stagedUrls) {
            const filename = path.basename(new URL(stagedUrl).pathname);
            const localPath = path.join(workDir, filename);

            const response = await fetch(stagedUrl);

            if (!response.ok) {
              throw new Error(`Failed to download ${stagedUrl}: ${response.status}`);
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            fs.writeFileSync(localPath, buffer);
            localPaths.push(localPath);
          }
        }

        console.log(`[pairing-v2-processor] Downloaded ${localPaths.length} images, running pipeline...`);

        // Run complete pipeline (handles batching internally for cross-image inference)
        let result: PairingResult;
        try {
          result = await runNewTwoStagePipeline(localPaths);
        } catch (pipelineError: any) {
          // Check if this is a retryable GPT API error
          if (pipelineError.message?.includes('Classification failed')) {
            console.error('[pairing-v2-processor] ❌ Pipeline failed due to GPT API errors after retries');
            throw new Error(
              'Image classification failed after multiple retry attempts. ' +
              'This is likely a temporary GPT API issue. Please try running Quick List again in a few minutes.'
            );
          }
          // Re-throw other errors as-is
          throw pipelineError;
        }

        console.log(`[pairing-v2-processor] Pipeline complete: ${result.pairs.length} pairs, ${result.unpaired.length} unpaired`);

        // Create shareable URLs for each paired image (method-specific)
        console.log(`[pairing-v2-processor] Creating shareable URLs for ${result.pairs.length} pairs (${uploadMethod} mode)...`);
        const pairsWithUrls = await Promise.all(result.pairs.map(async (p) => {
          let frontUrl: string;
          let backUrl: string;
          
          if (uploadMethod === "dropbox") {
            // Dropbox mode: Create Dropbox shared links
            const frontPath = `${job.folder}/${path.basename(p.front)}`;
            const backPath = `${job.folder}/${path.basename(p.back)}`;
            
            // Helper to get or create share link
            const getShareLink = async (dropboxPath: string): Promise<string> => {
              try {
                // Try to create a new shared link
                const createResponse = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${job.accessToken}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    path: dropboxPath,
                    settings: {
                      requested_visibility: 'public'
                    }
                  })
                });
                
                if (createResponse.ok) {
                  const data = await createResponse.json();
                  return data.url.replace('?dl=0', '?dl=1');
                }
                
                // Link might already exist, try to list existing links
                const listResponse = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${job.accessToken}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    path: dropboxPath,
                    direct_only: true
                  })
                });
                
                if (listResponse.ok) {
                  const listData = await listResponse.json();
                  if (listData.links && listData.links.length > 0) {
                    return listData.links[0].url.replace('?dl=0', '?dl=1');
                  }
                }
                
                // Fallback: return a constructed URL (may not work but better than nothing)
                console.warn(`[pairing-v2-processor] Could not create share link for ${dropboxPath}`);
                return `https://www.dropbox.com/home${dropboxPath}?dl=1`;
              } catch (err) {
                console.error(`[pairing-v2-processor] Error creating share link for ${dropboxPath}:`, err);
                return `https://www.dropbox.com/home${dropboxPath}?dl=1`;
              }
            };
            
            [frontUrl, backUrl] = await Promise.all([
              getShareLink(frontPath),
              getShareLink(backPath)
            ]);
          } else {
            // Local mode: Use the staged URLs directly
            const frontFilename = path.basename(p.front);
            const backFilename = path.basename(p.back);
            
            // Find the corresponding staged URLs
            frontUrl = job.stagedUrls.find((url: string) => url.includes(frontFilename)) || '';
            backUrl = job.stagedUrls.find((url: string) => url.includes(backFilename)) || '';
            
            if (!frontUrl || !backUrl) {
              console.warn(`[pairing-v2-processor] Could not find staged URLs for ${frontFilename} or ${backFilename}`);
            }
          }
          
          return {
            ...p,
            frontUrl,
            backUrl
          };
        }));

        // Convert full paths to basenames for storage
        const basenamePairs = pairsWithUrls.map(p => ({
          front: path.basename(p.front),
          back: path.basename(p.back),
          confidence: p.confidence,
          brand: p.brand,
          brandWebsite: p.brandWebsite,
          product: p.product,
          title: p.title, // Book title (null for products)
          keyText: p.keyText || [], // Key text from product packaging
          frontUrl: p.frontUrl,  // Dropbox shareable link for front image
          backUrl: p.backUrl,    // Dropbox shareable link for back image
        }));

        // Create URLs for unpaired items (method-specific)
        // For Dropbox mode, we skip creating shared links for unpaired items to avoid rate limits
        // They can be accessed via Dropbox directly if needed for review
        console.log(`[pairing-v2-processor] Processing ${result.unpaired.length} unpaired items (${uploadMethod} mode)...`);
        
        let basenameSingletons: any[];
        
        if (uploadMethod === "local") {
          // Local mode: Include staged URLs for unpaired items
          basenameSingletons = result.unpaired.map(u => {
            const filename = path.basename(u.imagePath);
            const imageUrl = job.stagedUrls.find((url: string) => url.includes(filename));
            
            if (!imageUrl) {
              console.warn(`[pairing-v2-processor] Could not find staged URL for unpaired ${filename}`);
            }
            
            return {
              imagePath: filename,
              imageUrl,
              reason: u.reason,
              needsReview: u.needsReview,
            };
          });
        } else {
          // Dropbox mode: Skip creating shared links for unpaired items to avoid rate limits
          // Just include the basename and reason - UI can handle missing images gracefully
          basenameSingletons = result.unpaired.map(u => ({
            imagePath: path.basename(u.imagePath),
            imageUrl: undefined, // Skip Dropbox shared link creation for unpaired items
            reason: u.reason,
            needsReview: u.needsReview,
          }));
          
          console.log(`[pairing-v2-processor] Skipped Dropbox shared link creation for ${result.unpaired.length} unpaired items (rate limit optimization)`);
        }

        const finalResult = {
          pairs: basenamePairs,
          unpaired: basenameSingletons,
          metrics: result.metrics,
        };

        // Update job with result
        job.status = "completed";
        job.result = finalResult;
        job.processedCount = totalImages;
        job.updatedAt = Date.now();
        // Keep accessToken for thumbnail fetching in UI

        await redisSet(key, JSON.stringify(job), JOB_TTL);
        console.log(`[pairing-v2-processor] ✅ Job complete: ${basenamePairs.length} pairs, ${basenameSingletons.length} unpaired`);

        return {
          statusCode: 200,
          body: JSON.stringify({ ok: true, jobId, status: "completed", pairs: basenamePairs.length }),
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
    console.error(`[pairing-v2-processor] Job ${jobId} failed:`, err);

    // Update job with error
    const errorData = await redisGet(key);
    if (errorData) {
      const job: any = JSON.parse(errorData);
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      job.updatedAt = Date.now();
      // Keep accessToken for potential retry
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
