/**
 * Auto-promotion helper for newly published listings
 * 
 * This module handles automatic promotion of drafts when they're published to eBay.
 * Key features:
 * - Never blocks listing creation (errors are logged, not thrown)
 * - Respects draft-level ad rate overrides
 * - Falls back to user's promotion defaults
 * - Comprehensive logging for debugging
 */

import { promoteSingleListing } from './ebay-promote.js';
import { tokensStore } from './_blobs.js';
import { userScopedKey } from './_auth.js';

export interface AutoPromoteContext {
  userId: string;
  sku: string;
  autoPromote: boolean;
  autoPromoteAdRate?: number;
  accessToken: string;
  offerId?: string; // For logging
}

export interface AutoPromoteResult {
  attempted: boolean;
  success: boolean;
  sku: string;
  campaignId?: string;
  adId?: string;
  adRate?: number;
  error?: string;
  reason?: string;
}

/**
 * Attempts to promote a newly published listing if autoPromote is enabled.
 * 
 * @param ctx - Context with user, SKU, and promotion settings
 * @returns Result object (never throws)
 */
export async function maybeAutoPromoteDraftListing(
  ctx: AutoPromoteContext
): Promise<AutoPromoteResult> {
  const { userId, sku, autoPromote, autoPromoteAdRate, accessToken, offerId } = ctx;

  // Early return if auto-promotion is disabled
  if (!autoPromote) {
    console.log(`[autoPromote] Auto-promotion not enabled for SKU ${sku}`);
    return {
      attempted: false,
      success: false,
      sku,
      reason: 'Auto-promotion disabled',
    };
  }

  try {
    console.log(`[autoPromote] Auto-promotion enabled for SKU ${sku}${offerId ? `, offerId ${offerId}` : ''}`);
    
    // 1) Determine ad rate: draft override, then defaults, then fallback
    let adRate: number = autoPromoteAdRate || 5; // Start with draft override or fallback
    
    if (!autoPromoteAdRate) {
      // Load promotion defaults to get default ad rate
      const store = tokensStore();
      const policyDefaultsKey = userScopedKey(userId, 'policy-defaults.json');
      
      try {
        const policyDefaults: any = (await store.get(policyDefaultsKey, { type: 'json' })) || {};
        adRate = policyDefaults.defaultAdRate || 5; // Fall back to 5% if not set
        console.log(`[autoPromote] Using default ad rate from policy: ${adRate}%`);
      } catch (e) {
        adRate = 5; // Ultimate fallback
        console.log(`[autoPromote] Using hardcoded fallback ad rate: ${adRate}%`);
      }
    } else {
      console.log(`[autoPromote] Using draft-specific ad rate: ${adRate}%`);
    }

    // 2) Call promotion for this single SKU
    const tokenCache: any = {
      get: async (userId: string) => accessToken,
      set: async (userId: string, token: string, expiresIn: number) => {},
    };

    const promoStatus = await promoteSingleListing({
      tokenCache,
      userId,
      ebayAccountId: userId,
      inventoryReferenceId: sku,
      adRate,
    });

    console.log(`[autoPromote] Promotion result for SKU ${sku}:`, {
      enabled: promoStatus.enabled,
      campaignId: promoStatus.campaignId,
      adId: promoStatus.adId,
      adRate: promoStatus.adRate,
    });

    // 3) Return success or failure based on promotion status
    if (promoStatus.enabled && promoStatus.campaignId) {
      return {
        attempted: true,
        success: true,
        sku,
        campaignId: promoStatus.campaignId,
        adId: promoStatus.adId || undefined,
        adRate,
      };
    } else {
      // Promotion was attempted but didn't succeed
      console.warn(`[autoPromote] Promotion not enabled in result for SKU ${sku}`, promoStatus);
      return {
        attempted: true,
        success: false,
        sku,
        adRate,
        reason: 'Promotion enabled flag is false in result',
      };
    }
  } catch (err: any) {
    // Log error but return a failure result (never throw)
    console.error(`[autoPromote] Unexpected error promoting SKU ${sku}:`, {
      userId,
      sku,
      offerId,
      error: err.message,
      stack: err.stack,
    });

    return {
      attempted: true,
      success: false,
      sku,
      error: err.message,
      reason: 'Exception during promotion',
    };
  }
}
