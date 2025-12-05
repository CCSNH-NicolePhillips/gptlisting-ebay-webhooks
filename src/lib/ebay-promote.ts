/**
 * eBay Promoted Listings API Integration
 * 
 * This module provides functionality to interact with eBay's Marketing API
 * for managing promoted listings campaigns and ads.
 * 
 * API Documentation: https://developer.ebay.com/api-docs/sell/marketing/overview.html
 */

import { cfg } from '../config.js';
import { getEbayAccessToken } from './ebay-auth.js';
import {
  PromotedListingResult,
  PromotedListingsConfig,
  PromoteOfferOnceRequest,
  PromoteOfferOnceResult,
  EbayCampaignResponse,
  EbayAdResponse,
  AdCreateRequest,
  PromotionStatus,
  PromoteSkuResult,
} from './marketing-types.js';
import { tokensStore } from './_blobs.js';
import { userScopedKey } from './_auth.js';
import { accessTokenFromRefresh, tokenHosts } from './_common.js';

const DEFAULT_AD_RATE = 5.0; // 5% default ad rate
const MARKETPLACE_ID = cfg.ebay.defaultMarketplaceId;

export interface EbayTokenCache {
  get(userId: string): Promise<string | null>;
  set(userId: string, token: string, expiresIn: number): Promise<void>;
}

// Task 3: Single-listing promotion types
export interface PromoteSingleListingParams {
  tokenCache: EbayTokenCache;
  userId: string;
  ebayAccountId: string;
  inventoryReferenceId: string;
  adRate: number;
  campaignIdOverride?: string;
}

type AccessContext = {
  userId: string;
  accessToken: string;
  apiHost: string;
};

interface MarketingRequestOptions extends RequestInit {
  path: string;
  method?: string;
}

interface CampaignCache {
  [userId: string]: {
    campaignId: string;
    expiresAt: number;
  };
}

// Cache campaigns per user (in-memory, will reset on server restart)
const userCampaignCache: CampaignCache = {};

// Helper to get API host for eBay marketing calls
function getMarketingApiHost(): string {
  const env = process.env.NODE_ENV || 'production';
  return env === 'production'
    ? 'https://api.ebay.com'
    : 'https://api.sandbox.ebay.com';
}

// Task 3: Access context helper (similar to ebay-adapter.ts)
async function ensureAccess(params: {
  tokenCache: EbayTokenCache;
  userId: string;
  ebayAccountId: string;
}): Promise<AccessContext> {
  const { tokenCache, userId, ebayAccountId } = params;
  const trimmed = userId.trim();
  if (!trimmed) throw new Error('Missing userId for eBay access');
  
  // Try cache first
  const cached = await tokenCache.get(trimmed);
  const { apiHost } = tokenHosts(process.env.EBAY_ENV);
  
  if (cached) {
    return { userId: trimmed, accessToken: cached, apiHost };
  }
  
  // Fetch from blob storage
  const store = tokensStore();
  const saved = (await store.get(userScopedKey(trimmed, 'ebay.json'), {
    type: 'json',
  })) as any;
  
  const refresh = typeof saved?.refresh_token === 'string' ? saved.refresh_token : null;
  if (!refresh) {
    throw new Error(`No eBay refresh token found for user ${trimmed}`);
  }
  
  const { access_token } = await accessTokenFromRefresh(refresh);
  if (!access_token) {
    throw new Error('Failed to exchange refresh token for access token');
  }
  
  // Cache it
  await tokenCache.set(trimmed, access_token, 3600);
  
  return { userId: trimmed, accessToken: access_token, apiHost };
}

// Task 3: Marketing API request helper
async function marketingRequest<T>(
  ctx: AccessContext,
  options: MarketingRequestOptions
): Promise<T> {
  const { accessToken, apiHost } = ctx;
  const url = new URL(options.path, `https://${apiHost}`);
  const { path, method, headers, body, ...rest } = options;

  const resp = await fetch(url.toString(), {
    method: method ?? 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...headers,
    },
    body,
    ...rest,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(
      `Marketing API ${options.method ?? 'GET'} ${options.path} failed: ` +
      `${resp.status} ${resp.statusText} – ${text}`
    );
  }

  // Some marketing endpoints return 201 + empty body
  const contentLength = resp.headers.get('content-length');
  const hasBody = contentLength !== '0' && contentLength !== null;
  if (!hasBody) {
    return {} as T;
  }

  return (await resp.json()) as T;
}

// Task 3: Get or create default campaign ID
async function getOrCreateDefaultCampaignId(
  ctx: AccessContext,
  params: { adRate: number }
): Promise<string> {
  // Check cache first
  const cached = userCampaignCache[ctx.userId];
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[getOrCreateDefaultCampaignId] Using cached campaign: ${cached.campaignId}`);
    return cached.campaignId;
  }

  // Try env var override first (for backwards compatibility)
  const envCampaignId = process.env.EBAY_DEFAULT_PROMO_CAMPAIGN_ID;
  if (envCampaignId) {
    console.log(`[getOrCreateDefaultCampaignId] Using env campaign: ${envCampaignId}`);
    userCampaignCache[ctx.userId] = {
      campaignId: envCampaignId,
      expiresAt: Date.now() + 1000 * 60 * 60, // 1 hour cache
    };
    return envCampaignId;
  }

  // Fetch user's existing campaigns
  console.log(`[getOrCreateDefaultCampaignId] Fetching campaigns for user: ${ctx.userId}`);
  const apiHost = ctx.apiHost || getMarketingApiHost();
  const url = `${apiHost}/sell/marketing/v1/ad_campaign?campaign_status=RUNNING&limit=50`;
  
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${ctx.accessToken}`,
      'Content-Type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to fetch campaigns: ${res.status} ${errorText}`);
  }

  const data = await res.json() as { campaigns?: Array<{ campaignId: string; campaignName: string; campaignStatus: string }> };
  
  if (data.campaigns && data.campaigns.length > 0) {
    // Use the first RUNNING campaign
    const campaignId = data.campaigns[0].campaignId;
    console.log(`[getOrCreateDefaultCampaignId] Found existing campaign: ${campaignId} (${data.campaigns[0].campaignName})`);
    
    // Cache it
    userCampaignCache[ctx.userId] = {
      campaignId,
      expiresAt: Date.now() + 1000 * 60 * 60, // 1 hour cache
    };
    
    return campaignId;
  }

  // No campaigns found - user needs to create one in eBay Seller Hub
  throw new Error('No RUNNING promotion campaigns found. Please create a campaign in eBay Seller Hub first: https://www.ebay.com/sh/mkt/campaigns');
}

export class EbayPromote {
  /**
   * Get or create a default campaign for a user
   */
  private async getOrCreateDefaultCampaign(
    userId: string,
    accessToken: string,
    apiHost: string,
    campaignNameHint?: string
  ): Promise<string> {
    // Check cache first
    const cached = userCampaignCache[userId];
    if (cached && cached.expiresAt > Date.now()) {
      return cached.campaignId;
    }

    // Check if there's a global campaign ID in config
    if (cfg.ebay.promotedCampaignId) {
      // Verify it exists
      try {
        await this.getCampaign(accessToken, apiHost, cfg.ebay.promotedCampaignId);
        // Cache it
        userCampaignCache[userId] = {
          campaignId: cfg.ebay.promotedCampaignId,
          expiresAt: Date.now() + 1000 * 60 * 60, // 1 hour cache
        };
        return cfg.ebay.promotedCampaignId;
      } catch {
        // Campaign doesn't exist, create a new one
      }
    }

    // Create a new campaign
    const campaignName = campaignNameHint || `DraftPilot Campaign - ${userId}`;
    const campaign = await this.createCampaign(accessToken, apiHost, {
      campaignName,
      marketplaceId: MARKETPLACE_ID,
      fundingStrategy: {
        fundingModel: 'COST_PER_SALE',
        bidPercentage: DEFAULT_AD_RATE.toFixed(1),
      },
      startDate: new Date().toISOString(),
    });

    // Cache the campaign ID
    userCampaignCache[userId] = {
      campaignId: campaign.campaignId,
      expiresAt: Date.now() + 1000 * 60 * 60, // 1 hour cache
    };

    return campaign.campaignId;
  }

  /**
   * Create a new ad campaign
   */
  private async createCampaign(
    accessToken: string,
    apiHost: string,
    request: {
      campaignName: string;
      marketplaceId: string;
      fundingStrategy: {
        fundingModel: 'COST_PER_SALE';
        bidPercentage: string;
      };
      startDate: string;
      endDate?: string;
    }
  ): Promise<{ campaignId: string; campaignName: string; campaignStatus: string }> {
    const url = `${apiHost}/sell/marketing/v1/ad_campaign`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US',
      },
      body: JSON.stringify(request),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Campaign creation failed ${res.status}: ${text}`);
    }

    return JSON.parse(text);
  }

  /**
   * Get campaign details
   */
  private async getCampaign(
    accessToken: string,
    apiHost: string,
    campaignId: string
  ): Promise<{ campaignId: string; campaignStatus: string }> {
    const url = `${apiHost}/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Accept-Language': 'en-US',
      },
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Campaign fetch failed ${res.status}: ${text}`);
    }

    return JSON.parse(text);
  }

  /**
   * Create ads for listings in a campaign (bulk operation)
   */
  private async bulkCreateAdsByInventoryReference(
    accessToken: string,
    apiHost: string,
    campaignId: string,
    requests: Array<{
      bidPercentage: string;
      inventoryReferenceId: string;
      inventoryReferenceType: 'INVENTORY_ITEM' | 'INVENTORY_ITEM_GROUP';
    }>
  ): Promise<{
    ads: Array<{
      adId?: string;
      inventoryReferenceId: string;
      inventoryReferenceType: string;
      statusCode: number;
      errors?: Array<{ code: string; message: string }>;
    }>;
  }> {
    const url = `${apiHost}/sell/marketing/v1/ad_campaign/${encodeURIComponent(
      campaignId
    )}/bulk_create_ads_by_inventory_reference`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US',
      },
      body: JSON.stringify({ requests }),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Ad creation failed ${res.status}: ${text}`);
    }

    return JSON.parse(text);
  }

  /**
   * Promote a single inventory reference (listing)
   * 
   * This is the main public method for promoting listings.
   * It handles campaign creation/reuse and ad creation in one call.
   */
  public async promoteInventoryReference(options: {
    userId: string;
    inventoryReferenceId: string;
    inventoryReferenceType: 'INVENTORY_ITEM' | 'INVENTORY_ITEM_GROUP';
    adRate?: number;            // optional; fallback to default
    campaignNameHint?: string;  // e.g. "DraftPilot Default Campaign"
  }): Promise<PromotedListingResult> {
    const { userId, inventoryReferenceId, inventoryReferenceType } = options;

    // Validate ad rate
    const adRate = options.adRate ?? DEFAULT_AD_RATE;
    if (adRate < 1 || adRate > 20) {
      throw new Error('Ad rate must be between 1% and 20%');
    }

    // Get eBay access token
    const { token: accessToken, apiHost } = await getEbayAccessToken(userId);

    // Get or create a default campaign for this user
    const campaignId = await this.getOrCreateDefaultCampaign(
      userId,
      accessToken,
      apiHost,
      options.campaignNameHint
    );

    // Create the ad
    const response = await this.bulkCreateAdsByInventoryReference(
      accessToken,
      apiHost,
      campaignId,
      [
        {
          bidPercentage: adRate.toFixed(1),
          inventoryReferenceId,
          inventoryReferenceType,
        },
      ]
    );

    // Map the response to PromotedListingResult
    const ad = response.ads[0];
    if (!ad) {
      throw new Error('No ad response received from eBay');
    }

    // Determine status
    let status: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'ENDED' = 'PENDING';
    if (ad.statusCode === 200 || ad.statusCode === 201) {
      status = 'ACTIVE';
    } else if (ad.statusCode >= 400) {
      status = 'REJECTED';
    }

    const result: PromotedListingResult = {
      campaignId,
      adId: ad.adId || '',
      inventoryReferenceId: ad.inventoryReferenceId,
      inventoryReferenceType: ad.inventoryReferenceType as 'INVENTORY_ITEM' | 'INVENTORY_ITEM_GROUP',
      adRate,
      status,
      createdAt: new Date().toISOString(),
    };

    // Add errors if present
    if (ad.errors && ad.errors.length > 0) {
      result.errors = ad.errors.map((err: any) => ({
        code: err.errorId || err.code || 'UNKNOWN',
        message: err.message || 'Unknown error',
      }));
    }

    return result;
  }
}

// Export singleton instance
export const ebayPromote = new EbayPromote();

// ============================================================================
// STANDALONE HELPER FUNCTIONS FOR ORCHESTRATION
// ============================================================================

/**
 * Get all campaigns for a user
 */
export async function getCampaigns(
  userId: string,
  opts: { tokenCache?: EbayTokenCache; limit?: number } = {}
): Promise<{ campaigns: EbayCampaignResponse[] }> {
  const accessToken = await getEbayAccessToken(userId);
  const apiHost = getMarketingApiHost();
  const limit = opts.limit ?? 100;
  
  const url = `${apiHost}/sell/marketing/v1/ad_campaign?campaign_status=RUNNING,PAUSED&limit=${limit}`;
  
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get campaigns ${res.status}: ${text}`);
  }
  
  const data = await res.json();
  return { campaigns: data.campaigns || [] };
}

/**
 * Create a new campaign
 */
export async function createCampaign(
  userId: string,
  payload: any,
  opts: { tokenCache?: EbayTokenCache } = {}
): Promise<EbayCampaignResponse> {
  const accessToken = await getEbayAccessToken(userId);
  const apiHost = getMarketingApiHost();
  
  const url = `${apiHost}/sell/marketing/v1/ad_campaign`;
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create campaign ${res.status}: ${text}`);
  }
  
  return await res.json();
}

/**
 * Get all ads for a campaign
 */
export async function getAds(
  userId: string,
  campaignId: string,
  opts: { tokenCache?: EbayTokenCache; limit?: number } = {}
): Promise<{ ads: EbayAdResponse[] }> {
  const accessToken = await getEbayAccessToken(userId);
  const apiHost = getMarketingApiHost();
  const limit = opts.limit ?? 200;
  
  const url = `${apiHost}/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad?limit=${limit}`;
  
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get ads ${res.status}: ${text}`);
  }
  
  const data = await res.json();
  return { ads: data.ads || [] };
}

/**
 * Create ads in a campaign
 */
export async function createAds(
  userId: string,
  campaignId: string,
  payload: any,
  opts: { tokenCache?: EbayTokenCache } = {}
): Promise<{ ads: EbayAdResponse[] }> {
  const accessToken = await getEbayAccessToken(userId);
  const apiHost = getMarketingApiHost();
  
  const url = `${apiHost}/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad`;
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create ads ${res.status}: ${text}`);
  }
  
  const data = await res.json();
  return { ads: data.ads || data.responses || [] };
}

/**
 * Update an ad's bid rate
 */
export async function updateAdRate(
  userId: string,
  campaignId: string,
  adId: string,
  newAdRate: number,
  opts: { tokenCache?: EbayTokenCache } = {}
): Promise<void> {
  const accessToken = await getEbayAccessToken(userId);
  const apiHost = getMarketingApiHost();
  
  const url = `${apiHost}/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad/${encodeURIComponent(adId)}`;
  
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ bidPercentage: newAdRate }),
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to update ad rate ${res.status}: ${text}`);
  }
}

/**
 * High-level helper to ensure a single offer is promoted according to the
 * provided PromotedListingsConfig.
 *
 * Responsibilities:
 *  - Find or create a campaign that matches the config
 *  - Find or create an ad for the offer inside that campaign
 *  - Adjust the ad rate if it's out of sync with the config
 */
export async function promoteOfferOnce(
  req: PromoteOfferOnceRequest,
  opts: { tokenCache?: EbayTokenCache } = {}
): Promise<PromoteOfferOnceResult> {
  const { userId, offerId, marketplaceId, config } = req;

  // If promotion is disabled in the config, we simply early-return
  if (!config.enabled) {
    throw new Error('Promoted listings are disabled in configuration.');
  }

  // 1) Find an existing campaign that matches this strategy OR create one.
  const { campaigns } = await getCampaigns(userId, { tokenCache: opts.tokenCache });

  const targetCampaignName = `DraftPilot – ${marketplaceId} – Auto`;
  const targetMarketplace = marketplaceId;

  let campaign = campaigns.find((c) => {
    // If campaignId is specified in config, use that exact campaign
    if (config.campaignId) {
      return c.campaignId === config.campaignId;
    }
    // Otherwise, find by name and marketplace
    return (
      c.campaignName === targetCampaignName &&
      (c.marketplaceId === targetMarketplace || !c.marketplaceId) &&
      c.campaignStatus !== 'ENDED'
    );
  });

  let wasCampaignCreated = false;

  if (!campaign) {
    const startDate = new Date();
    startDate.setMinutes(startDate.getMinutes() + 5); // small buffer

    const createPayload = {
      campaignName: targetCampaignName,
      campaignStatus: 'RUNNING',
      fundingStrategy: {
        bidPercentage: config.adRate ?? 4,
        fundingModel: 'COST_PER_SALE',
      },
      marketplaceId: targetMarketplace,
      startDate: startDate.toISOString(),
    };

    campaign = await createCampaign(userId, createPayload, { tokenCache: opts.tokenCache });
    wasCampaignCreated = true;
  }

  if (!campaign || !campaign.campaignId) {
    throw new Error('Failed to resolve a valid campaign for promotion.');
  }

  const campaignId = campaign.campaignId;

  // 2) Check if an ad already exists for this offer
  const { ads } = await getAds(userId, campaignId, { tokenCache: opts.tokenCache, limit: 200 });

  const existingAd = ads.find((ad) => {
    // Match by inventoryReferenceId or check for listingId in case API varies
    return (
      ad.inventoryReferenceId === offerId ||
      (ad as any).listingId === offerId ||
      (ad as any).offeringId === offerId
    );
  });

  let adId: string;
  let finalAdRate = config.adRate ?? 4;
  let wasAdCreated = false;
  let wasAdRateUpdated = false;

  if (!existingAd) {
    // 3) No ad yet – create one
    const createAdsPayload = {
      requests: [
        {
          listingId: offerId,
          listingType: 'OFFER', // adjust if your integration uses a different type
          bidPercentage: finalAdRate,
        },
      ],
    };

    const createResult = await createAds(userId, campaignId, createAdsPayload, {
      tokenCache: opts.tokenCache,
    });

    const firstAd = createResult.ads?.[0];
    if (!firstAd || !firstAd.adId) {
      throw new Error('Failed to create promoted listings ad for offer.');
    }

    adId = firstAd.adId;
    wasAdCreated = true;
  } else {
    // 4) Ad exists – sync the rate if needed
    adId = existingAd.adId;

    const currentRate = parseFloat(existingAd.bidPercentage);
    if (
      !isNaN(currentRate) &&
      Math.round(currentRate * 100) !== Math.round(finalAdRate * 100)
    ) {
      await updateAdRate(userId, campaignId, adId, finalAdRate, { tokenCache: opts.tokenCache });
      wasAdRateUpdated = true;
    } else {
      finalAdRate = isNaN(currentRate) ? finalAdRate : currentRate;
    }
  }

  return {
    campaignId,
    campaignName: targetCampaignName,
    adId,
    finalAdRate,
    wasCampaignCreated,
    wasAdCreated,
    wasAdRateUpdated,
  };
}

// ============================================================================
// TASK 3: SINGLE-LISTING PROMOTION HELPER
// ============================================================================

/**
 * Promote a single inventory item (SKU) in eBay's Marketing API.
 * 
 * This is the building block for:
 *  - "Promote" button per draft
 *  - "Promote all" on the drafts page
 *  - Later, auto price reduction logic that decides adRate dynamically
 * 
 * @param params - Configuration for the promotion
 * @returns PromotionStatus indicating success/failure and current promotion state
 */
export async function promoteSingleListing(
  params: PromoteSingleListingParams
): Promise<PromotionStatus> {
  const { tokenCache, userId, ebayAccountId, inventoryReferenceId, adRate, campaignIdOverride } = params;

  // 4a) Get access token + host
  const ctx = await ensureAccess({
    tokenCache,
    userId,
    ebayAccountId,
  });

  // 4b) Decide campaignId
  const campaignId =
    campaignIdOverride ??
    (await getOrCreateDefaultCampaignId(ctx, { adRate }));

  // 4c) Build AdCreateRequest (marketing-types.ts)
  const bidPercentage = adRate.toFixed(1); // 5 -> "5.0"

  const requestBody: AdCreateRequest = {
    bidPercentage,
    inventoryReferenceId,
    inventoryReferenceType: 'INVENTORY_ITEM',
  };

  try {
    // 4d) Call eBay Marketing API to create the ad
    await marketingRequest<unknown>(ctx, {
      path: `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad`,
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    // On 201 created or 200 OK, return a "happy" PromotionStatus
    const status: PromotionStatus = {
      enabled: true,
      adRate,
      campaignId,
      adId: null, // we'll enrich this later once we parse Location/response
      impressions: 0,
      clicks: 0,
      sales: 0,
      adFees: 0,
    };

    return status;
  } catch (err: any) {
    const msg = String(err?.message ?? err ?? '');

    // 4e) Gracefully handle "already promoted" style errors from eBay
    const alreadyPromoted =
      msg.includes('already been created') ||
      msg.includes('inventory reference already in campaign') ||
      msg.includes('duplicate');

    if (alreadyPromoted) {
      return {
        enabled: true,
        adRate,
        campaignId,
        adId: null,
        impressions: 0,
        clicks: 0,
        sales: 0,
        adFees: 0,
      };
    }

    // 4f) For now, on other errors, return a disabled PromotionStatus instead
    //     of throwing, so the UI can show "failed to promote" without
    //     crashing the whole batch.
    console.error('[promoteSingleListing] Failed to promote listing', {
      inventoryReferenceId,
      campaignId,
      adRate,
      error: msg,
    });

    return {
      enabled: false,
      adRate: null,
      campaignId: null,
      adId: null,
      impressions: 0,
      clicks: 0,
      sales: 0,
      adFees: 0,
    };
  }
}

// ============================================================================
// TASK 4: BATCH PROMOTION HELPER
// ============================================================================

/**
 * Promote multiple SKUs for a single user at a given ad rate.
 *
 * This is a convenience wrapper so the rest of the app can call
 * one function instead of juggling campaigns and individual ads.
 * 
 * @param userId - Auth0/DraftPilot user ID
 * @param skus - Array of inventory reference IDs (SKUs) to promote
 * @param adRatePercent - Ad rate percentage (e.g., 5 for 5%)
 * @param options - Optional token cache
 * @returns Campaign ID and per-SKU promotion results
 */
export async function promoteSkusForUser(
  userId: string,
  skus: string[],
  adRatePercent: number,
  options: { tokenCache?: EbayTokenCache } = {}
): Promise<{
  campaignId: string;
  results: PromoteSkuResult[];
}> {
  if (!skus.length) {
    return {
      campaignId: '',
      results: [],
    };
  }

  // We'll use a shared token cache for all SKUs
  const tokenCache = options.tokenCache || new Map<string, string>() as any;
  
  // Track the campaign ID (should be the same for all SKUs)
  let campaignId = '';
  const results: PromoteSkuResult[] = [];

  // Promote each SKU using the existing promoteSingleListing helper
  for (const sku of skus) {
    try {
      const status = await promoteSingleListing({
        tokenCache,
        userId,
        ebayAccountId: userId, // Using userId as ebayAccountId for now
        inventoryReferenceId: sku,
        adRate: adRatePercent,
      });

      // Capture the campaign ID from the first successful promotion
      if (!campaignId && status.campaignId) {
        campaignId = status.campaignId;
      }

      results.push({
        sku,
        campaignId: status.campaignId || campaignId || '',
        adId: status.adId,
        adRatePercent,
        status,
      });
    } catch (err: any) {
      // If an individual SKU fails, include it in results as disabled
      console.error(`[promoteSkusForUser] Failed to promote SKU ${sku}:`, err.message);
      
      results.push({
        sku,
        campaignId: campaignId || '',
        adId: null,
        adRatePercent,
        status: {
          enabled: false,
          adRate: null,
          campaignId: null,
          adId: null,
          impressions: 0,
          clicks: 0,
          sales: 0,
          adFees: 0,
        },
      });
    }
  }

  return { campaignId, results };
}
