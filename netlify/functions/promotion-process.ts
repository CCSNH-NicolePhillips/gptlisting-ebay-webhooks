/**
 * Promotion Process - Client-callable job processor
 * 
 * Processes queued promotion jobs on-demand. The frontend can call this
 * endpoint periodically after publishing drafts instead of relying on
 * scheduled functions (which require Netlify Pro plan).
 * 
 * GET /.netlify/functions/promotion-process
 *   Returns queue stats and processes ready jobs
 * 
 * POST /.netlify/functions/promotion-process
 *   Forces processing of a specific job by jobId
 */

import type { Handler, HandlerEvent } from '../../src/types/api-handler.js';
import { requireAuthVerified } from '../../src/lib/_auth.js';
import { getReadyJobs, updateJob, getQueueStats, getJobStatus } from '../../src/lib/promotion-queue.js';
import {
  createAds,
  getCampaigns,
  createCampaign,
  promoteSingleListing,
  type EbayTokenCache,
} from '../../src/lib/ebay-promote.js';

// Maximum concurrent promotions to process per invocation
const MAX_CONCURRENT = 5; // Lower than worker since this is user-triggered

// Token cache for this invocation
const tokenCacheStore = new Map<string, { token: string; expiresAt: number }>();

const tokenCache: EbayTokenCache = {
  async get(userId: string) {
    const record = tokenCacheStore.get(userId);
    if (record && record.expiresAt > Date.now()) {
      return record.token;
    }
    return null;
  },
  async set(userId: string, token: string, expiresIn: number) {
    const ttlMs = Math.max(0, (expiresIn || 3600) * 1000 - 5000);
    tokenCacheStore.set(userId, { token, expiresAt: Date.now() + ttlMs });
  },
};

function isRetryableError(message: string): boolean {
  if (!message) return false;
  return /35048|listing not synced|listing not ready|publish the listing first|Temporarily unavailable/i.test(message);
}

async function tryPromoteViaSku(job: any) {
  if (!job.sku) {
    return { outcome: 'fallback' as const };
  }

  try {
    await promoteSingleListing({
      tokenCache,
      userId: job.userId,
      ebayAccountId: job.userId,
      inventoryReferenceId: job.sku,
      adRate: job.adRate,
      campaignIdOverride: job.campaignId,
    });
    console.log(`[promotion-process] ✓ Job ${job.id} succeeded via SKU ${job.sku}`);
    return { outcome: 'success' as const };
  } catch (error: any) {
    const message = error?.message || String(error);
    if (isRetryableError(message)) {
      console.warn(`[promotion-process] SKU promotion pending for job ${job.id}: ${message}`);
      return { outcome: 'retry' as const, error: message };
    }
    console.warn(`[promotion-process] SKU promotion failed for job ${job.id}, falling back to listingId: ${message}`);
    return { outcome: 'fallback' as const, error: message };
  }
}

async function getOrCreateCampaign(userId: string, providedCampaignId?: string): Promise<string> {
  if (providedCampaignId) {
    return providedCampaignId;
  }

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

  const startDate = new Date().toISOString();
  const campaign = await createCampaign(userId, {
    campaignName: autoName,
    marketplaceId: 'EBAY_US',
    fundingStrategy: {
      fundingModel: 'COST_PER_SALE',
    },
    startDate,
  });

  console.log(`[promotion-process] Created new campaign: ${campaign.campaignId}`);
  return campaign.campaignId;
}

async function processJob(job: any): Promise<{ success: boolean; error?: string }> {
  try {
    console.log(`[promotion-process] Processing job ${job.id}: listing ${job.listingId}, attempt ${job.attempts + 1}/${job.maxAttempts}`);

    const skuResult = await tryPromoteViaSku(job);
    if (skuResult.outcome === 'success') {
      return { success: true };
    }
    if (skuResult.outcome === 'retry') {
      return { success: false, error: skuResult.error };
    }

    if (!job.listingId) {
      return { success: false, error: 'Missing listingId for fallback promotion' };
    }

    const campaignId = await getOrCreateCampaign(job.userId, job.campaignId);
    const payload = {
      listingId: job.listingId,
      bidPercentage: String(job.adRate),
    };

    const result = await createAds(job.userId, campaignId, payload);

    if (result.ads && result.ads.length > 0) {
      console.log(`[promotion-process] ✓ Job ${job.id} succeeded - ad created: ${result.ads[0].adId}`);
      return { success: true };
    }

    console.log(`[promotion-process] ✓ Job ${job.id} succeeded - empty response (eBay accepted)`);
    return { success: true };
  } catch (error: any) {
    const errorMsg = error.message || String(error);
    console.error(`[promotion-process] ✗ Job ${job.id} failed:`, errorMsg);

    if (isRetryableError(errorMsg) || errorMsg.includes('invalid or has ended')) {
      return { success: false, error: errorMsg };
    }

    if (errorMsg.includes('35001') || errorMsg.includes('already exists')) {
      console.log(`[promotion-process] ✓ Job ${job.id} - ad already exists`);
      return { success: true };
    }

    return { success: false, error: errorMsg };
  }
}

export const handler: Handler = async (event: HandlerEvent) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    // Verify authentication
    const auth = await requireAuthVerified(event);
    if (!auth) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }
    const userId = auth.sub;

    console.log(`[promotion-process] Processing request for user ${userId}`);

    // Get queue stats first
    const stats = await getQueueStats();

    if (stats.ready === 0) {
      console.log('[promotion-process] No jobs ready to process');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          message: 'No jobs ready',
          stats,
          processed: 0,
          succeeded: 0,
          retrying: 0,
          failed: 0,
        }),
      };
    }

    // Get ready jobs (only process jobs for this user ideally, but the queue is global)
    const jobs = await getReadyJobs(MAX_CONCURRENT);
    console.log(`[promotion-process] Processing ${jobs.length} jobs`);

    // Filter to only this user's jobs for safety
    const userJobs = jobs.filter(job => job.userId === userId);
    console.log(`[promotion-process] ${userJobs.length} jobs belong to user ${userId}`);

    if (userJobs.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          message: 'No jobs ready for this user',
          stats,
          processed: 0,
          succeeded: 0,
          retrying: 0,
          failed: 0,
        }),
      };
    }

    // Process jobs sequentially to avoid rate limits
    let succeeded = 0;
    let failed = 0;
    let retrying = 0;
    const jobResults: Array<{ jobId: string; listingId: string; status: string; error?: string }> = [];

    for (const job of userJobs) {
      const result = await processJob(job);
      await updateJob(job.id, result.success, result.error);

      if (result.success) {
        succeeded++;
        jobResults.push({ jobId: job.id, listingId: job.listingId, status: 'success' });
      } else {
        if (job.attempts + 1 < job.maxAttempts) {
          retrying++;
          jobResults.push({ jobId: job.id, listingId: job.listingId, status: 'retrying', error: result.error });
        } else {
          failed++;
          jobResults.push({ jobId: job.id, listingId: job.listingId, status: 'failed', error: result.error });
        }
      }
    }

    console.log(`[promotion-process] Batch complete: ${succeeded} succeeded, ${retrying} retrying, ${failed} failed`);

    // Get updated stats
    const updatedStats = await getQueueStats();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        processed: userJobs.length,
        succeeded,
        retrying,
        failed,
        stats: updatedStats,
        jobs: jobResults,
      }),
    };

  } catch (error: any) {
    console.error('[promotion-process] Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Processing failed',
        message: error.message 
      }),
    };
  }
};
