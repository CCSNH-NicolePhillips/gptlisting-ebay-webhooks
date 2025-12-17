/**
 * Promotion Worker - Background job processor
 * 
 * Scheduled function that runs every minute to process queued promotion jobs.
 * Handles eBay's sync delays with retry logic.
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { getReadyJobs, updateJob, getQueueStats } from '../../src/lib/promotion-queue.js';
import { createAds, getCampaigns, createCampaign } from '../../src/lib/ebay-promote.js';

// Maximum concurrent promotions to process per invocation
const MAX_CONCURRENT = 10;

/**
 * Get or create campaign for a user
 */
async function getOrCreateCampaign(userId: string, providedCampaignId?: string): Promise<string> {
  // If campaign ID provided, use it
  if (providedCampaignId) {
    return providedCampaignId;
  }

  // Search for existing "DraftPilot Auto" campaign
  const { campaigns } = await getCampaigns(userId, { limit: 50 });
  
  const now = new Date();
  const autoName = `DraftPilot Auto ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  
  const existingCampaign = campaigns.find(c => 
    c.campaignName?.includes('DraftPilot Auto') && 
    c.campaignStatus === 'RUNNING'
  );
  
  if (existingCampaign) {
    return existingCampaign.campaignId;
  }

  // Create new campaign
  const startDate = new Date().toISOString();
  const campaign = await createCampaign(userId, {
    campaignName: autoName,
    marketplaceId: 'EBAY_US',
    fundingStrategy: {
      fundingModel: 'COST_PER_SALE',
    },
    startDate,
  });

  console.log(`[promotion-worker] Created new campaign: ${campaign.campaignId}`);
  return campaign.campaignId;
}

/**
 * Process a single promotion job
 */
async function processJob(job: any): Promise<{ success: boolean; error?: string }> {
  try {
    console.log(`[promotion-worker] Processing job ${job.id}: listing ${job.listingId}, attempt ${job.attempts + 1}/${job.maxAttempts}`);

    // Get or create campaign
    const campaignId = await getOrCreateCampaign(job.userId, job.campaignId);

    // Attempt to create ad
    const payload = {
      listingId: job.listingId,
      bidPercentage: String(job.adRate),
    };

    const result = await createAds(job.userId, campaignId, payload);

    // Check result
    if (result.ads && result.ads.length > 0) {
      console.log(`[promotion-worker] ✓ Job ${job.id} succeeded - ad created: ${result.ads[0].adId}`);
      return { success: true };
    } else {
      // Empty response - eBay accepted but no details yet (this is actually success)
      console.log(`[promotion-worker] ✓ Job ${job.id} succeeded - empty response (eBay accepted)`);
      return { success: true };
    }

  } catch (error: any) {
    const errorMsg = error.message || String(error);
    console.error(`[promotion-worker] ✗ Job ${job.id} failed:`, errorMsg);

    // Check for specific errors
    if (errorMsg.includes('35048') || errorMsg.includes('invalid or has ended')) {
      // Listing not ready yet - retry
      return { success: false, error: 'Listing not synced yet' };
    }

    if (errorMsg.includes('35001') || errorMsg.includes('already exists')) {
      // Ad already exists - consider success
      console.log(`[promotion-worker] ✓ Job ${job.id} - ad already exists`);
      return { success: true };
    }

    // Other errors - retry
    return { success: false, error: errorMsg };
  }
}

/**
 * Main handler - processes queued promotion jobs
 */
export const handler: Handler = async (event: HandlerEvent) => {
  console.log('[promotion-worker] Starting batch processing');

  try {
    // Get queue stats
    const stats = await getQueueStats();
    console.log(`[promotion-worker] Queue stats:`, stats);

    if (stats.ready === 0) {
      console.log('[promotion-worker] No jobs ready to process');
      return {
        statusCode: 200,
        body: JSON.stringify({ 
          message: 'No jobs ready',
          stats 
        }),
      };
    }

    // Get ready jobs
    const jobs = await getReadyJobs(MAX_CONCURRENT);
    console.log(`[promotion-worker] Processing ${jobs.length} jobs`);

    // Process jobs concurrently (but limited)
    const results = await Promise.allSettled(
      jobs.map(job => processJob(job))
    );

    // Update job statuses
    let succeeded = 0;
    let failed = 0;
    let retrying = 0;

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const result = results[i];

      if (result.status === 'fulfilled') {
        const { success, error } = result.value;
        await updateJob(job.id, success, error);
        
        if (success) {
          succeeded++;
        } else {
          if (job.attempts + 1 < job.maxAttempts) {
            retrying++;
          } else {
            failed++;
          }
        }
      } else {
        // Promise rejected
        await updateJob(job.id, false, result.reason?.message || 'Unknown error');
        if (job.attempts + 1 < job.maxAttempts) {
          retrying++;
        } else {
          failed++;
        }
      }
    }

    console.log(`[promotion-worker] Batch complete: ${succeeded} succeeded, ${retrying} retrying, ${failed} failed`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        processed: jobs.length,
        succeeded,
        retrying,
        failed,
        stats: await getQueueStats(),
      }),
    };

  } catch (error: any) {
    console.error('[promotion-worker] Worker error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Worker failed',
        message: error.message 
      }),
    };
  }
};
