/**
 * Background processor for pairing-v2 jobs
 * This function is called directly by the scheduler to process a specific job
 */

import { Handler } from "@netlify/functions";
import { getPairingV2JobStatus } from "../../src/lib/pairingV2Jobs.js";
import { runNewTwoStagePipeline, type PairingResult } from "../../src/smartdrafts/pairing-v2-core.js";
import { copyToStaging, getStagedUrl } from "../../src/lib/storage.js";
import { guessMime } from "../../src/lib/mime.js";
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
          return null;
        }

        const data: any = await response.json();
        return data.link;
      } catch (err) {
        console.error(`Error getting temp link for ${filePath}:`, err);
        return null;
      }
    });

    const batchLinks = await Promise.all(batchPromises);
    links.push(...batchLinks.filter((link): link is string => link !== null));
  }

  return links;
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
        // Convert shared link to direct download format
        let url = existingData.links[0].url;
        url = url.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace('?dl=0', '?raw=1');
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
            const url = existingUrl.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace('?dl=0', '?raw=1');
            console.log(`[pairing-v2-processor] Using existing shared link (from 409) for ${filePath}`);
            return url;
          }
        } catch {}
      }
      console.error(`Failed to create shared link for ${filePath}: ${createResponse.status} ${errorText}`);
      return null;
    }
    
    const data: any = await createResponse.json();
    // Convert shared link to direct download format
    let url = data.url;
    url = url.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace('?dl=0', '?raw=1');
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
        if (tempLinks.length === 0) {
          throw new Error("Failed to get temporary links from Dropbox");
        }
        imageSources = tempLinks;
        console.log(`[pairing-v2-processor] Got ${tempLinks.length} temp links`);
      }
      
      // Create temp directory
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `pairing-v2-${jobId}-`));

      try {
        // Download all images from staged URLs (works for both local and Dropbox modes)
        const localPaths: string[] = [];
        const filenameHints = job.dropboxFilenames || []; // Original filenames for Dropbox
        
        for (let i = 0; i < imageSources.length; i++) {
          const imageUrl = imageSources[i];
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
        }

        if (localPaths.length === 0) {
          throw new Error(`No valid image URLs found. Check that scan job contains proper stagedUrls or Dropbox temp links.`);
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
          let frontUrl: string = '';
          let backUrl: string = '';
          let side1Url: string | undefined;
          let side2Url: string | undefined;
          
          if (uploadMethod === "dropbox") {
            // Dropbox mode: Try to stage images to R2/S3 for full quality and stable URLs
            // If R2/S3 not configured, fall back to Dropbox temp links directly
            const frontFilename = path.basename(p.front);
            const backFilename = path.basename(p.back);
            const side1Filename = p.side1 ? path.basename(p.side1) : null;
            const side2Filename = p.side2 ? path.basename(p.side2) : null;
            
            // Find the original Dropbox temp link for each image
            const imageSources = job.stagedUrls || job.dropboxPaths || [];
            const filenameHints = job.dropboxFilenames || [];
            
            // Helper to find the source URL for a filename
            const findSourceUrl = (targetFilename: string): string | null => {
              for (let i = 0; i < imageSources.length; i++) {
                const hint = filenameHints[i] || '';
                if (hint === targetFilename) {
                  return imageSources[i];
                }
                // Also check URL path for filename
                try {
                  const urlFilename = path.basename(new URL(imageSources[i]).pathname);
                  if (urlFilename === targetFilename) {
                    return imageSources[i];
                  }
                } catch {}
              }
              return null;
            };
            
            // Check if R2/S3 is properly configured
            const hasR2Config = !!(process.env.R2_BUCKET || process.env.S3_BUCKET) && 
                               !!(process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID) &&
                               !!(process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY);
            
            console.log(`[pairing-v2-processor] R2 config check: hasR2Config=${hasR2Config}, hasAccessToken=${!!job.accessToken}, dropboxPathsCount=${job.dropboxPaths?.length || 0}`);
            
            if (hasR2Config) {
              // Helper to stage image to R2/S3
              const stageToR2 = async (filename: string): Promise<string> => {
                const sourceUrl = findSourceUrl(filename);
                if (!sourceUrl) {
                  console.warn(`[pairing-v2-processor] Could not find source URL for ${filename}`);
                  return '';
                }
                
                try {
                  const mime = guessMime(filename);
                  const stagingKey = await copyToStaging(sourceUrl, job.userId, filename, mime, jobId);
                  const stagedUrl = await getStagedUrl(stagingKey);
                  console.log(`[pairing-v2-processor] Staged ${filename} to R2: ${stagedUrl.substring(0, 60)}...`);
                  return stagedUrl;
                } catch (err) {
                  console.error(`[pairing-v2-processor] Failed to stage ${filename} to R2:`, err);
                  return '';
                }
              };
              
              // Stage front and back images (required)
              [frontUrl, backUrl] = await Promise.all([
                stageToR2(frontFilename),
                stageToR2(backFilename)
              ]);
              
              // Stage side images (optional)
              if (side1Filename) {
                side1Url = await stageToR2(side1Filename) || undefined;
              }
              if (side2Filename) {
                side2Url = await stageToR2(side2Filename) || undefined;
              }
            }
            
            // Fallback: Use Dropbox persistent shared links if R2 staging failed or not configured
            // We create shared links instead of temp links because temp links expire after 4 hours
            // and we need persistent URLs for eBay inventory that will be accessed later
            console.log(`[pairing-v2-processor] Checking shared link fallback: frontUrl="${frontUrl?.substring(0, 50) || ''}", backUrl="${backUrl?.substring(0, 50) || ''}", hasAccessToken=${!!job.accessToken}`);
            
            if (!frontUrl && job.accessToken) {
              const dropboxPath = job.dropboxPaths?.find((p: string) => p.includes(frontFilename));
              console.log(`[pairing-v2-processor] Looking for dropbox path for "${frontFilename}": found="${dropboxPath || 'NOT FOUND'}"`);
              if (dropboxPath) {
                frontUrl = await getDropboxSharedLink(job.accessToken, dropboxPath) || '';
                if (frontUrl) {
                  console.log(`[pairing-v2-processor] ✓ Created shared link for front: ${frontUrl.substring(0, 60)}...`);
                } else {
                  console.error(`[pairing-v2-processor] ✗ Failed to create shared link for front: ${frontFilename}`);
                }
              }
            }
            if (!backUrl && job.accessToken) {
              const dropboxPath = job.dropboxPaths?.find((p: string) => p.includes(backFilename));
              if (dropboxPath) {
                backUrl = await getDropboxSharedLink(job.accessToken, dropboxPath) || '';
                if (backUrl) {
                  console.log(`[pairing-v2-processor] ✓ Created shared link for back: ${backUrl.substring(0, 60)}...`);
                } else {
                  console.error(`[pairing-v2-processor] ✗ Failed to create shared link for back: ${backFilename}`);
                }
              }
            }
            if (side1Filename && !side1Url && job.accessToken) {
              const dropboxPath = job.dropboxPaths?.find((p: string) => p.includes(side1Filename));
              if (dropboxPath) {
                side1Url = await getDropboxSharedLink(job.accessToken, dropboxPath) || undefined;
              }
            }
            if (side2Filename && !side2Url && job.accessToken) {
              const dropboxPath = job.dropboxPaths?.find((p: string) => p.includes(side2Filename));
              if (dropboxPath) {
                side2Url = await getDropboxSharedLink(job.accessToken, dropboxPath) || undefined;
              }
            }
            
            // Final fallback: Use temp links as last resort (these expire after 4h but better than nothing)
            if (!frontUrl) {
              frontUrl = findSourceUrl(frontFilename) || '';
              console.warn(`[pairing-v2-processor] Using temp link (expires 4h) for front: ${frontFilename}`);
            }
            if (!backUrl) {
              backUrl = findSourceUrl(backFilename) || '';
              console.warn(`[pairing-v2-processor] Using temp link (expires 4h) for back: ${backFilename}`);
            }
            if (side1Filename && !side1Url) {
              side1Url = findSourceUrl(side1Filename) || undefined;
            }
            if (side2Filename && !side2Url) {
              side2Url = findSourceUrl(side2Filename) || undefined;
            }
            
            if (!frontUrl || !backUrl) {
              console.warn(`[pairing-v2-processor] Could not get image URLs for pair: ${frontFilename}, ${backFilename}`);
            }
          } else {
            // Local mode: Use the staged URLs directly
            const frontFilename = path.basename(p.front);
            const backFilename = path.basename(p.back);
            const side1Filename = p.side1 ? path.basename(p.side1) : null;
            const side2Filename = p.side2 ? path.basename(p.side2) : null;
            
            // Find the corresponding staged URLs
            frontUrl = job.stagedUrls.find((url: string) => url.includes(frontFilename)) || '';
            backUrl = job.stagedUrls.find((url: string) => url.includes(backFilename)) || '';
            
            if (side1Filename) {
              side1Url = job.stagedUrls.find((url: string) => url.includes(side1Filename)) || undefined;
            }
            if (side2Filename) {
              side2Url = job.stagedUrls.find((url: string) => url.includes(side2Filename)) || undefined;
            }
            
            if (!frontUrl || !backUrl) {
              console.warn(`[pairing-v2-processor] Could not find staged URLs for ${frontFilename} or ${backFilename}`);
            }
          }
          
          return {
            ...p,
            frontUrl,
            backUrl,
            side1Url,
            side2Url
          };
        }));

        // Convert full paths to basenames for storage
        const basenamePairs = pairsWithUrls.map(p => {
          const photoQty = p.photoQuantity || 1;
          const imageCount = 2 + (p.side1 ? 1 : 0) + (p.side2 ? 1 : 0);
          console.log(`[pairing-v2-processor] Storing pair: brand=${p.brand}, photoQuantity=${photoQty}, packCount=${p.packCount ?? 'null'}, images=${imageCount}`);
          return {
            front: path.basename(p.front),
            back: path.basename(p.back),
            side1: p.side1 ? path.basename(p.side1) : undefined,
            side2: p.side2 ? path.basename(p.side2) : undefined,
            confidence: p.confidence,
            brand: p.brand,
            brandWebsite: p.brandWebsite,
            product: p.product,
            title: p.title, // Book title (null for products)
            keyText: p.keyText || [], // Key text from product packaging
            categoryPath: p.categoryPath || null, // Vision category path (e.g., "Health & Personal Care > Vitamins & Dietary Supplements")
            photoQuantity: photoQty, // CHUNK 3: How many physical products visible in photo
            packCount: p.packCount ?? null, // CRITICAL: Number of units in package (e.g., 24 for 24-pack) - used for variant pricing
            frontUrl: p.frontUrl,  // Shareable link for front image
            backUrl: p.backUrl,    // Shareable link for back image
            side1Url: p.side1Url,  // Shareable link for side1 image (optional)
            side2Url: p.side2Url,  // Shareable link for side2 image (optional)
          };
        });

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
              panel: u.panel || 'unknown',
              brand: u.brand || null,
              product: u.product || null,
              title: u.title || null,
              brandWebsite: u.brandWebsite || null,
              keyText: u.keyText || [],
              categoryPath: u.categoryPath || null,
              photoQuantity: u.photoQuantity || 1, // CHUNK 3: How many physical products visible in photo
              packCount: u.packCount ?? null, // CRITICAL: Number of units in package for variant pricing
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
