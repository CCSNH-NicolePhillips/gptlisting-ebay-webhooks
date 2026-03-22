/**
 * packages/core/src/services/drafts/create-draft-user.ts
 *
 * Create eBay draft listings from GPT-analysed product groups.
 * Money path — mirrors create-ebay-draft-user.ts netlify handler.
 */

import { mapGroupToDraft } from '../../../../../src/lib/map-group-to-draft.js';
import { putBinding } from '../../../../../src/lib/bind-store.js';
import { updateDraftLogsOfferId } from '../../../../../src/lib/draft-logs.js';
import { getEbayAccessTokenStrict } from '../../../../../src/lib/ebay-auth.js';
import { tokensStore } from '../../../../../src/lib/redis-store.js';
import { userScopedKey } from '../../../../../src/lib/_auth.js';
import { createOffer, putInventoryItem } from '../../../../../src/lib/ebay-sell.js';
import { storePromotionIntent } from '../../../../../src/lib/promotion-queue.js';
import { tokenHosts } from '../../../../../src/lib/_common.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateDraftResult = {
  sku: string;
  offerId: string;
  warnings: unknown[];
  status?: string;
};

export type GroupAttentionReason = {
  severity: 'error' | 'warning';
  message: string;
};

export type CreateDraftGroupInput = {
  groupId?: string;
  id?: string;
  attentionReasons?: GroupAttentionReason[];
  [key: string]: unknown;
};

export class BlockingIssuesError extends Error {
  readonly statusCode = 400;
  readonly groupId: string;
  readonly attentionReasons: GroupAttentionReason[];
  constructor(groupId: string, reasons: GroupAttentionReason[]) {
    super(`Draft has ${reasons.length} issue(s) that must be resolved before publishing`);
    this.name = 'BlockingIssuesError';
    this.groupId = groupId;
    this.attentionReasons = reasons;
  }
}

export class MappingError extends Error {
  readonly statusCode = 400;
  readonly groupId: string;
  constructor(groupId: string, detail: string) {
    super(`Failed to map group: ${detail}`);
    this.name = 'MappingError';
    this.groupId = groupId;
  }
}

export class MissingRequiredSpecificsError extends Error {
  readonly statusCode = 400;
  readonly groupId: string;
  readonly missing: string[];
  constructor(groupId: string, missing: string[]) {
    super(`Missing required specifics: ${missing.join(', ')}`);
    this.name = 'MissingRequiredSpecificsError';
    this.groupId = groupId;
    this.missing = missing;
  }
}

export class InvalidLocationError extends Error {
  readonly statusCode = 400;
  readonly groupId: string;
  readonly invalidKey: string | null;
  readonly availableKeys: string[];
  constructor(groupId: string, invalidKey: string | null, availableKeys: string[]) {
    super(
      `Invalid merchantLocationKey '${invalidKey ?? '(none)'}' — not found in available locations`,
    );
    this.name = 'InvalidLocationError';
    this.groupId = groupId;
    this.invalidKey = invalidKey;
    this.availableKeys = availableKeys;
  }
}

export class EbayAuthError extends Error {
  readonly statusCode = 502;
  constructor(detail: string) {
    super(`eBay auth failed: ${detail}`);
    this.name = 'EbayAuthError';
  }
}

export class DraftCreationError extends Error {
  readonly statusCode = 502;
  readonly groupId: string;
  constructor(groupId: string, detail: string) {
    super(`Failed to create eBay draft: ${detail}`);
    this.name = 'DraftCreationError';
    this.groupId = groupId;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toGroupId(group: CreateDraftGroupInput): string {
  const raw = group?.groupId ?? group?.id;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
}

async function fetchInventoryLocations(
  token: string,
  apiHost: string,
): Promise<Array<{ key: string; isDefault: boolean }>> {
  const MARKETPLACE_ID = process.env.DEFAULT_MARKETPLACE_ID || process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
  const url = `${apiHost}/sell/inventory/v1/location?limit=200`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Accept-Language': 'en-US',
      'Content-Language': 'en-US',
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
    },
  });
  if (!r.ok) return [];
  const text = await r.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list: any[] = Array.isArray(data?.locations)
    ? data.locations
    : Array.isArray(data?.locationResponses)
      ? data.locationResponses
      : [];
  return list
    .map((loc) => ({
      key: typeof loc?.merchantLocationKey === 'string' ? loc.merchantLocationKey : '',
      isDefault:
        Array.isArray(loc?.locationTypes) &&
        (loc.locationTypes.includes('WAREHOUSE') || loc.locationTypes.includes('DEFAULT')),
    }))
    .filter((l) => l.key.length > 0);
}

async function fetchOfferById(
  token: string,
  apiHost: string,
  offerId: string,
  marketplaceId: string,
): Promise<any> {
  const url = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Accept-Language': 'en-US',
      'Content-Language': 'en-US',
      'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
    },
  });
  const txt = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`get-offer ${r.status}: ${txt}`);
  return txt ? JSON.parse(txt) : null;
}

async function resolveLocation(
  userId: string,
  store: any,
  availableLocations: Array<{ key: string; isDefault: boolean }>,
  mapped: any,
): Promise<string | null> {
  const availableKeys = availableLocations.map((l) => l.key);
  let key: string | null =
    (mapped.offer.merchantLocationKey && String(mapped.offer.merchantLocationKey)) || null;

  if (!key) {
    try {
      const saved = (await store.get(userScopedKey(userId, 'ebay-location.json'), { type: 'json' })) as any;
      const candidate = typeof saved?.merchantLocationKey === 'string' ? saved.merchantLocationKey.trim() : '';
      if (candidate && availableKeys.includes(candidate)) {
        key = candidate;
      } else if (candidate && !availableKeys.includes(candidate)) {
        await store.setJSON(userScopedKey(userId, 'ebay-location.json'), null);
      }
    } catch {
      // ignore
    }
  }

  if (!key && availableKeys.length === 1) {
    key = availableKeys[0];
    try {
      await store.setJSON(userScopedKey(userId, 'ebay-location.json'), {
        merchantLocationKey: key,
        savedAt: new Date().toISOString(),
        autoSelected: true,
      });
    } catch {
      // ignore
    }
  }

  if (!key && availableLocations.length > 1) {
    const def = availableLocations.find((l) => l.isDefault);
    key = def ? def.key : availableLocations[0].key;
    try {
      await store.setJSON(userScopedKey(userId, 'ebay-location.json'), {
        merchantLocationKey: key,
        savedAt: new Date().toISOString(),
        autoSelected: true,
        source: def ? 'ebay-default' : 'first-available',
      });
    } catch {
      // ignore
    }
  }

  if (!key && process.env.EBAY_MERCHANT_LOCATION_KEY) {
    key = process.env.EBAY_MERCHANT_LOCATION_KEY;
  }

  return key;
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

/**
 * Create eBay inventory item + offer for each validated product group.
 *
 * @param userId   Authenticated user ID
 * @param jobId    Job/scan ID the groups belong to
 * @param groups   Array of product groups from GPT analysis
 * @returns        Array of creation results (sku + offerId)
 *
 * @throws various typed errors — route handler maps these to HTTP responses
 */
export async function createEbayDraftsFromGroups(
  userId: string,
  jobId: string,
  groups: CreateDraftGroupInput[],
): Promise<CreateDraftResult[]> {
  const store = tokensStore();

  // Load user policy defaults
  let userPolicyDefaults: {
    fulfillment?: string;
    /** Free-shipping policy — applied when item price < FREE_SHIPPING_THRESHOLD */
    fulfillmentFree?: string;
    payment?: string;
    return?: string;
    promoCampaignId?: string | null;
  } = {};
  try {
    const saved = (await store.get(userScopedKey(userId, 'policy-defaults.json'), { type: 'json' })) as any;
    if (saved && typeof saved === 'object') {
      userPolicyDefaults = {
        fulfillment: typeof saved.fulfillment === 'string' ? saved.fulfillment : undefined,
        fulfillmentFree: typeof saved.fulfillmentFree === 'string' ? saved.fulfillmentFree : undefined,
        payment: typeof saved.payment === 'string' ? saved.payment : undefined,
        return: typeof saved.return === 'string' ? saved.return : undefined,
        promoCampaignId: typeof saved.promoCampaignId === 'string' ? saved.promoCampaignId : null,
      };
    }
  } catch {
    // ignore
  }

  /**
   * Pick the correct fulfillment policy.
   * Only split on the $50 threshold when the user has TWO DISTINCT policies.
   * When both policies are the same (or only one is set), use that single
   * policy for ALL items — this respects "free shipping as my default".
   */
  function pickFulfillmentPolicy(price: unknown): string | null {
    const hasTwoPolicies = userPolicyDefaults.fulfillment &&
      userPolicyDefaults.fulfillmentFree &&
      userPolicyDefaults.fulfillment !== userPolicyDefaults.fulfillmentFree;

    if (hasTwoPolicies) {
      const FREE_SHIPPING_THRESHOLD = 50;
      const numPrice = Number(price);
      if (Number.isFinite(numPrice) && numPrice < FREE_SHIPPING_THRESHOLD) {
        return userPolicyDefaults.fulfillmentFree!;
      }
      return userPolicyDefaults.fulfillment!;
    }

    // Single policy (or both are the same) → use it for all items
    return userPolicyDefaults.fulfillment ?? userPolicyDefaults.fulfillmentFree ?? null;
  }

  // Pre-validate and map all groups (fail fast before any eBay API call)
  type Prepared = { group: CreateDraftGroupInput; mapped: any; groupId: string };
  const prepared: Prepared[] = [];

  for (const group of groups) {
    const groupId = toGroupId(group);
    if (!groupId) throw Object.assign(new Error('Group missing groupId'), { statusCode: 400 });

    const attentionReasons = Array.isArray(group.attentionReasons) ? group.attentionReasons : [];
    const blockingIssues = attentionReasons.filter((r) => r?.severity === 'error');
    if (blockingIssues.length > 0) throw new BlockingIssuesError(groupId, blockingIssues);

    let mapped: any;
    try {
      mapped = await mapGroupToDraft(group, { jobId, userId });
    } catch (err: any) {
      throw new MappingError(groupId, err?.message || String(err ?? ''));
    }

    const missing = Array.isArray(mapped._meta?.missingRequired)
      ? (mapped._meta.missingRequired as string[]).filter(Boolean)
      : [];
    if (missing.length) throw new MissingRequiredSpecificsError(groupId, missing);

    prepared.push({ group, mapped, groupId });
  }

  // eBay auth
  let access: { token: string; apiHost: string };
  try {
    const a = await getEbayAccessTokenStrict(userId);
    access = a;
  } catch (err: any) {
    throw new EbayAuthError(err?.message || String(err ?? ''));
  }

  // Fetch inventory locations
  const availableLocations = await fetchInventoryLocations(access.token, access.apiHost).catch(
    () => [],
  );

  // Create offers
  const results: CreateDraftResult[] = [];

  for (const { group, mapped, groupId } of prepared) {
    try {
      const marketplaceId =
        mapped.offer.marketplaceId ||
        process.env.DEFAULT_MARKETPLACE_ID ||
        process.env.EBAY_MARKETPLACE_ID ||
        'EBAY_US';

      const merchantLocationKey = await resolveLocation(userId, store, availableLocations, mapped);
      const availableKeys = availableLocations.map((l) => l.key);

      if (!merchantLocationKey || !availableKeys.includes(merchantLocationKey)) {
        throw new InvalidLocationError(groupId, merchantLocationKey, availableKeys);
      }

      // Set weight from group if provided
      const draftWeight = group.weight as { value?: number; unit?: string } | undefined;
      if (draftWeight?.value && draftWeight.value > 0) {
        mapped.inventory.packageWeightAndSize = {
          weight: {
            value: draftWeight.value,
            unit: (draftWeight.unit as 'OUNCE' | 'POUND') || 'OUNCE',
          },
        };
      }

      await putInventoryItem(
        access.token,
        access.apiHost,
        mapped.sku,
        mapped.inventory,
        mapped.offer.quantity,
        marketplaceId,
      );

      let offerResult: any;
      try {
        offerResult = await createOffer(access.token, access.apiHost, {
          sku: mapped.sku,
          marketplaceId,
          categoryId: mapped.offer.categoryId,
          price: mapped.offer.price,
          quantity: mapped.offer.quantity,
          condition: mapped.offer.condition,
          fulfillmentPolicyId:
            mapped.offer.fulfillmentPolicyId ?? pickFulfillmentPolicy(mapped.offer.price),
          paymentPolicyId: mapped.offer.paymentPolicyId ?? userPolicyDefaults.payment ?? null,
          returnPolicyId: mapped.offer.returnPolicyId ?? userPolicyDefaults.return ?? null,
          merchantLocationKey,
          description: mapped.offer.description,
          bestOffer: group.bestOffer as any,
          merchantData: {
            ...((group.pricingStatus || group.priceMeta)
              ? { pricingStatus: group.pricingStatus, priceMeta: group.priceMeta }
              : {}),
            ...((group.promotion as any)?.enabled
              ? { autoPromote: true, autoPromoteAdRate: (group.promotion as any).rate || 5 }
              : { autoPromote: false, autoPromoteAdRate: null }),
          },
        });
      } catch (e: any) {
        const msg = String(e?.message || e || '');
        // Handle idempotent conflict (25002 = offer already exists)
        if (/\berrorId\"?\s*:\s*25002\b/.test(msg)) {
          let existingOfferId = '';
          try {
            const jsonStart = msg.indexOf('{');
            if (jsonStart >= 0) {
              const parsed = JSON.parse(msg.slice(jsonStart));
              const errs = Array.isArray(parsed?.errors) ? parsed.errors : [];
              const p = (errs[0]?.parameters ?? []).find(
                (x: any) => String(x?.name ?? '') === 'offerId',
              );
              if (p && typeof p.value === 'string' && p.value.trim()) {
                existingOfferId = p.value.trim();
              }
            }
          } catch {
            // ignore
          }
          if (existingOfferId) {
            try {
              const off = await fetchOfferById(
                access.token,
                access.apiHost,
                existingOfferId,
                marketplaceId,
              );
              const r: CreateDraftResult = {
                sku: mapped.sku,
                offerId: existingOfferId,
                warnings: [],
                ...(off?.status ? { status: off.status } : {}),
              };
              results.push(r);
              await putBinding(userId, jobId, groupId, {
                sku: mapped.sku,
                offerId: existingOfferId,
                jobId,
                groupId,
                warnings: [],
                createdAt: Date.now(),
              }).catch(() => {});
              await updateDraftLogsOfferId(userId, groupId, existingOfferId).catch(() => {});
              continue;
            } catch {
              // fall through to throw
            }
          }
        }
        throw e;
      }

      // Store promotion intent if enabled
      if ((group.promotion as any)?.enabled && offerResult.offerId) {
        await storePromotionIntent(
          offerResult.offerId,
          true,
          (group.promotion as any).rate || 5,
        ).catch(() => {});
      }

      const status =
        (offerResult as any)?.raw?.offer?.status ||
        (offerResult as any)?.raw?.status ||
        undefined;
      const r: CreateDraftResult = {
        sku: mapped.sku,
        offerId: offerResult.offerId,
        warnings: offerResult.warnings,
        ...(status ? { status } : {}),
      };
      results.push(r);

      await putBinding(userId, jobId, groupId, {
        sku: mapped.sku,
        offerId: offerResult.offerId,
        jobId,
        groupId,
        warnings: offerResult.warnings,
        createdAt: Date.now(),
      }).catch(() => {});
      await updateDraftLogsOfferId(userId, groupId, offerResult.offerId).catch(() => {});
    } catch (err: any) {
      if (err instanceof InvalidLocationError || err instanceof BlockingIssuesError) throw err;
      throw new DraftCreationError(groupId, err?.message || String(err ?? ''));
    }
  }

  return results;
}
