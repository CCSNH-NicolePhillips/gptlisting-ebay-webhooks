/**
 * Background processor for pairing-v2 jobs
 * This function is called directly by the scheduler to process a specific job
 */

import { Handler } from "@netlify/functions";
import { getPairingV2JobStatus } from "../../src/lib/pairingV2Jobs.js";
import { runNewTwoStagePipeline, type PairingResult } from "../../src/smartdrafts/pairing-v2-core.js";
import { uploadBufferToStaging } from "../../src/lib/storage.js";
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

/**
 * Get temporary download links for Dropbox files (used when needsTempLinks is true)
 * IMPORTANT: Returns same-length array with empty strings for failed links to preserve index alignment
 */
async function getDropboxTemporaryLinks(accessToken: string, paths: string[]): Promise<string[]> {
  const links: string[] = [];
  
  // Get temp links in parallel (batch of 50 at a time - background function has more time)
  for (let i = 0; i < paths.length; i += 50) {
    const batch = paths.slice(i, i + 50);
    const batchPromises = batch.map(async (filePath) => {
      try {
        const response = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path: filePath }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`Failed to get temp link for ${filePath}: ${response.status} ${errorText}`);
          return ""; // Return empty string to preserve index alignment
        }

        const data: any = await response.json();
        return data.link || "";
      } catch (err) {
        console.error(`Error getting temp link for ${filePath}:`, err);
        return ""; // Return empty string to preserve index alignment
      }
    });

    const batchLinks = await Promise.all(batchPromises);
    // Push all results (including empty strings) to preserve index alignment
    links.push(...batchLinks);
  }

  return links;
}

/**
 * Convert Dropbox shared link to direct download format
 * Uses URL API for reliable parsing (handles &dl=0 anywhere in query string)
 */
function normalizeDropboxUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    // Change hostname to direct download host
    u.hostname = "dl.dropboxusercontent.com";
    // Remove dl param and add raw=1 for direct binary download
    u.searchParams.delete("dl");
    if (!u.searchParams.has("raw")) u.searchParams.set("raw", "1");
    return u.toString();
  } catch {
    // Fallback: return as-is if URL parsing fails
    return rawUrl;
  }
}

/**
 * Get persistent shared link for a Dropbox file (doesn't expire)
 * Creates one if it doesn't exist, or returns existing one
 */
async function getDropboxSharedLink(accessToken: string, filePath: string): Promise<string | null> {
  try {
    // First try to get existing shared link
    const existingResponse = await fetch("https://api.dropboxapi.com/2/sharing/list_shared_links", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: filePath, direct_only: true }),
    });
    
    if (existingResponse.ok) {
      const existingData: any = await existingResponse.json();
      if (existingData.links && existingData.links.length > 0) {
        const url = normalizeDropboxUrl(existingData.links[0].url);
        console.log(`[pairing-v2-processor] Using existing shared link for ${filePath}`);
        return url;
      }
    }
    
    // No existing link, create a new one
    const createResponse = await fetch("https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: filePath,
        settings: {
          requested_visibility: "public",
          audience: "public",
          access: "viewer"
        }
      }),
    });
    
    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      // Error 409 means link already exists (race condition)
      if (createResponse.status === 409 && errorText.includes('shared_link_already_exists')) {
        // Try to extract the existing link from the error response
        try {
          const errorData = JSON.parse(errorText);
          const existingUrl = errorData?.error?.shared_link_already_exists?.metadata?.url;
          if (existingUrl) {
            const url = normalizeDropboxUrl(existingUrl);
            console.log(`[pairing-v2-processor] Using existing shared link (from 409) for ${filePath}`);
            return url;
          }
        } catch {}
      }
      console.error(`Failed to create shared link for ${filePath}: ${createResponse.status} ${errorText}`);
      return null;
    }
    
    const data: any = await createResponse.json();
    const url = normalizeDropboxUrl(data.url);
    console.log(`[pairing-v2-processor] Created new shared link for ${filePath}`);
    return url;
  } catch (err) {
    console.error(`Error getting shared link for ${filePath}:`, err);
    return null;
  }
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

    const uploadMethod = job.uploadMethod || "local"; // Changed default to local since we use stagedUrls
    const totalImages = (job.stagedUrls || job.dropboxPaths || []).length;
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
      
      // If needsTempLinks is true, we need to fetch temp links from Dropbox paths
      let imageSources = job.stagedUrls || job.dropboxPaths || [];
      
      if (job.needsTempLinks && uploadMethod === "dropbox" && job.accessToken) {
        console.log(`[pairing-v2-processor] Fetching ${imageSources.length} temp links from Dropbox...`);
        const tempLinks = await getDropboxTemporaryLinks(job.accessToken, imageSources);
        const validLinkCount = tempLinks.filter(link => link).length;
        if (validLinkCount === 0) {
          throw new Error("Failed to get temporary links from Dropbox");
        }
        imageSources = tempLinks;
        console.log(`[pairing-v2-processor] Got ${validLinkCount} valid temp links of ${tempLinks.length} total`);
      }
      
      // Create temp directory
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `pairing-v2-${jobId}-`));

      try {
        // ========================================================================
        // STEP 1: Download all images and create persistent URL map
        // This map (filename → URL) is used for ALL downstream operations
        // No more Dropbox vs Local branching after this point!
        // ========================================================================
        const localPaths: string[] = [];
        const filenameHints = job.dropboxFilenames || []; // Original filenames for Dropbox
        const persistentUrlMap: Record<string, string> = {}; // filename → persistent URL
        
        console.log(`[pairing-v2-processor] Creating persistent URLs for ${imageSources.length} images...`);
        
        for (let i = 0; i < imageSources.length; i++) {
          const imageUrl = imageSources[i];
          
          // Skip empty URLs (failed temp link fetches) - preserves index alignment
          if (!imageUrl) {
            console.warn(`[pairing-v2-processor] Skipping empty image source at index ${i} (temp link fetch may have failed)`);
            continue;
          }
          
          let filename: string;
          let isValidUrl = false;
          
          // Check if this is a valid URL (S3, Dropbox temp link, etc.)
          try {
            new URL(imageUrl);
            // For Dropbox, use the original filename from the hint array
            if (uploadMethod === "dropbox" && filenameHints[i]) {
              filename = filenameHints[i];
            } else {
              filename = path.basename(new URL(imageUrl).pathname);
            }
            isValidUrl = true;
          } catch {
            // Not a valid URL - likely a bare filename from old scan format
            filename = path.basename(imageUrl);
            isValidUrl = false;
          }

          if (!isValidUrl) {
            console.warn(`[pairing-v2-processor] Skipping invalid image source (not a URL): ${imageUrl}`);
            continue;
          }

          const localPath = path.join(workDir, filename);

          const response = await fetch(imageUrl);

          if (!response.ok) {
            throw new Error(`Failed to download ${filename}: ${response.status}`);
          }

          const buffer = Buffer.from(await response.arrayBuffer());
          fs.writeFileSync(localPath, buffer);
          localPaths.push(localPath);
          
          // Create persistent URL for this image
          // ALWAYS upload to R2 for consistent quality (no 6MB proxy limit)
          // This gives Dropbox uploads the same quality as local uploads
          if (uploadMethod === "dropbox") {
            // Use userId or fallback to 'anonymous' for R2 path
            const userId = job.userId || 'anonymous';
            try {
              // Detect mime type from extension
              const ext = path.extname(filename).toLowerCase();
              const mimeMap: Record<string, string> = {
                '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.png': 'image/png', '.gif': 'image/gif',
                '.webp': 'image/webp', '.heic': 'image/heic',
              };
              const mime = mimeMap[ext] || 'image/jpeg';
              
              console.log(`[pairing-v2-processor] 📤 Uploading to R2: userId="${userId}", filename="${filename}", mime="${mime}", jobId="${jobId}"`);
              const r2Url = await uploadBufferToStaging(buffer, userId, filename, mime, jobId);
              persistentUrlMap[filename] = r2Url;
              console.log(`[pairing-v2-processor] ✓ Uploaded to R2: ${filename}`);
              console.log(`[pairing-v2-processor]   Full URL: ${r2Url}`);
              console.log(`[pairing-v2-processor]   URL contains pipe: ${r2Url.includes('|')}`);
              console.log(`[pairing-v2-processor]   URL contains %7C: ${r2Url.includes('%7C')}`);
            } catch (uploadErr: any) {
              console.error(`[pairing-v2-processor] ✗ R2 upload failed for ${filename}, falling back to Dropbox shared link:`, uploadErr?.message);
              // Fallback to Dropbox shared link if R2 fails
              if (job.accessToken && job.dropboxPaths?.[i]) {
                const sharedUrl = await getDropboxSharedLink(job.accessToken, job.dropboxPaths[i]);
                if (sharedUrl) {
                  persistentUrlMap[filename] = sharedUrl;
                  console.log(`[pairing-v2-processor] ✓ Fallback Dropbox URL for ${filename}`);
                }
              }
            }
          } else {
            // Local mode: stagedUrls are already S3/R2 URLs
            persistentUrlMap[filename] = imageUrl;
          }
        }

        if (localPaths.length === 0) {
          throw new Error(`No valid image URLs found. Check that scan job contains proper stagedUrls or Dropbox temp links.`);
        }
        
        console.log(`[pairing-v2-processor] Created ${Object.keys(persistentUrlMap).length} persistent URLs`);
        console.log(`[pairing-v2-processor] 📋 URL Map summary:`);
        for (const [fname, url] of Object.entries(persistentUrlMap)) {
          console.log(`[pairing-v2-processor]   ${fname} → ${url.substring(0, 100)}...`);
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

        // ========================================================================
        // STEP 2: Map pairing results to persistent URLs
        // Simple lookup from the map we created above - NO more Dropbox vs Local branching!
        // ========================================================================
        console.log(`[pairing-v2-processor] Mapping ${result.pairs.length} pairs to persistent URLs...`);
        console.log(`[pairing-v2-processor] Available filenames in URL map: ${Object.keys(persistentUrlMap).join(', ')}`);
        
        const basenamePairs = result.pairs.map(p => {
          const frontFilename = path.basename(p.front);
          const backFilename = path.basename(p.back);
          const side1Filename = p.side1 ? path.basename(p.side1) : null;
          const side2Filename = p.side2 ? path.basename(p.side2) : null;
          
          const frontUrl = persistentUrlMap[frontFilename] || '';
          const backUrl = persistentUrlMap[backFilename] || '';
          const side1Url = side1Filename ? persistentUrlMap[side1Filename] : undefined;
          const side2Url = side2Filename ? persistentUrlMap[side2Filename] : undefined;
          
          console.log(`[pairing-v2-processor] Pair mapping: front="${frontFilename}" → ${frontUrl ? frontUrl.substring(0, 80) + '...' : 'MISSING'}`);
          console.log(`[pairing-v2-processor] Pair mapping: back="${backFilename}" → ${backUrl ? backUrl.substring(0, 80) + '...' : 'MISSING'}`);
          if (side1Filename) console.log(`[pairing-v2-processor] Pair mapping: side1="${side1Filename}" → ${side1Url ? side1Url.substring(0, 80) + '...' : 'MISSING'}`);
          if (side2Filename) console.log(`[pairing-v2-processor] Pair mapping: side2="${side2Filename}" → ${side2Url ? side2Url.substring(0, 80) + '...' : 'MISSING'}`);
          
          if (!frontUrl || !backUrl) {
            console.warn(`[pairing-v2-processor] ⚠️ Missing URL for pair: front=${frontFilename} (${frontUrl ? 'OK' : 'MISSING'}), back=${backFilename} (${backUrl ? 'OK' : 'MISSING'})`);
          }
          
          const photoQty = p.photoQuantity || 1;
          console.log(`[pairing-v2-processor] Storing pair: brand=${p.brand}, photoQuantity=${photoQty}, packCount=${p.packCount ?? 'null'}, frontUrl=${frontUrl ? 'OK' : 'MISSING'}`);
          
          // 🔍 CRITICAL DEBUG: Log the full pair→URL association to verify correctness
          console.log(`[pairing-v2-processor] 📦 PAIR SUMMARY:`);
          console.log(`[pairing-v2-processor]   Brand: "${p.brand}", Product: "${p.product}"`);
          console.log(`[pairing-v2-processor]   Front file: "${frontFilename}"`);
          console.log(`[pairing-v2-processor]   Front URL hash: ${frontUrl.match(/\/([a-f0-9]+)-/)?.[1] || 'N/A'}`);
          console.log(`[pairing-v2-processor]   Back file: "${backFilename}"`);
          console.log(`[pairing-v2-processor]   Back URL hash: ${backUrl.match(/\/([a-f0-9]+)-/)?.[1] || 'N/A'}`);
          
          return {
            front: frontFilename,
            back: backFilename,
            side1: side1Filename || undefined,
            side2: side2Filename || undefined,
            confidence: p.confidence,
            brand: p.brand,
            brandWebsite: p.brandWebsite,
            product: p.product,
            title: p.title,
            keyText: p.keyText || [],
            categoryPath: p.categoryPath || null,
            photoQuantity: photoQty,
            packCount: p.packCount ?? null,
            frontUrl,
            backUrl,
            side1Url,
            side2Url,
          };
        });

        // Map unpaired items to persistent URLs
        const basenameSingletons = result.unpaired.map(u => {
          const filename = path.basename(u.imagePath);
          const imageUrl = persistentUrlMap[filename] || '';
          
          return {
            imagePath: filename,
            imageUrl,
            reason: u.reason,
            needsReview: u.needsReview,
            panel: u.panel,
            brand: u.brand,
            brandWebsite: u.brandWebsite,
            product: u.product,
            title: u.title,
            keyText: u.keyText || [],
            categoryPath: u.categoryPath || null,
            photoQuantity: u.photoQuantity || 1,
            packCount: u.packCount ?? null,
          };
        });

        const finalResult = {
          pairs: basenamePairs,
          unpaired: basenameSingletons,
          metrics: result.metrics,
        };

        // Log final pairs for debugging
        console.log(`[pairing-v2-processor] 📦 Final pairs to store:`);
        for (const pair of basenamePairs) {
          console.log(`[pairing-v2-processor]   Pair: brand=${pair.brand}, product=${pair.product}`);
          console.log(`[pairing-v2-processor]     frontUrl: ${pair.frontUrl || 'MISSING'}`);
          console.log(`[pairing-v2-processor]     backUrl: ${pair.backUrl || 'MISSING'}`);
        }

        // Update job with result
        job.status = "completed";
        job.result = finalResult;
        job.processedCount = totalImages;
        job.updatedAt = Date.now();

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
