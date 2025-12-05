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
import { PromotedListingResult } from './marketing-types.js';

const DEFAULT_AD_RATE = 5.0; // 5% default ad rate
const MARKETPLACE_ID = cfg.ebay.defaultMarketplaceId;

interface CampaignCache {
  [userId: string]: {
    campaignId: string;
    expiresAt: number;
  };
}

// Cache campaigns per user (in-memory, will reset on server restart)
const userCampaignCache: CampaignCache = {};

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
