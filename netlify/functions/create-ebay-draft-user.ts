import type { Handler } from "@netlify/functions";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, isOriginAllowed, json } from "../../src/lib/http.js";
import { mapGroupToDraft, type TaxonomyMappedDraft } from "../../src/lib/map-group-to-draft.js";
import { putBinding } from "../../src/lib/bind-store.js";
import { getEbayAccessTokenStrict } from "../../src/lib/ebay-auth.js";
import { tokensStore } from "../../src/lib/_blobs.js";
import { userScopedKey } from "../../src/lib/_auth.js";
import { createOffer, putInventoryItem } from "../../src/lib/ebay-sell.js";
import { promoteSingleListing } from "../../src/lib/ebay-promote.js";

async function fetchOfferById(token: string, apiHost: string, offerId: string, marketplaceId: string) {
  const url = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
    },
  });
  const txt = await r.text().catch(() => "");
  let json: any = null;
  try { json = txt ? JSON.parse(txt) : null; } catch { json = { raw: txt }; }
  if (!r.ok) throw new Error(`get-offer ${r.status}: ${txt}`);
  return json;
}

async function fetchInventoryLocations(accessToken: string, apiHost: string, marketplaceId: string): Promise<{ key: string; isDefault: boolean }[]> {
  const url = `${apiHost}/sell/inventory/v1/location?limit=200`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`locations ${r.status}: ${text.slice(0, 300)}`);
  try {
    const json = JSON.parse(text);
    const list = Array.isArray(json?.locations)
      ? json.locations
      : Array.isArray(json?.locationResponses)
      ? json.locationResponses
      : [];
    const locations: { key: string; isDefault: boolean }[] = [];
    for (const loc of list) {
      const k = typeof loc?.merchantLocationKey === "string" ? loc.merchantLocationKey : null;
      if (k) {
        // Check if this location is marked as default by eBay
        // eBay uses locationTypes array - if it contains "WAREHOUSE" it's often the primary/default
        const types = Array.isArray(loc.locationTypes) ? loc.locationTypes : [];
        const isDefault = types.includes("WAREHOUSE") || types.includes("DEFAULT") || false;
        locations.push({ key: k, isDefault });
      }
    }
    return locations;
  } catch {
    return [];
  }
}

// Helper to extract just the keys from locations
async function fetchInventoryLocationKeys(accessToken: string, apiHost: string, marketplaceId: string): Promise<string[]> {
  const locations = await fetchInventoryLocations(accessToken, apiHost, marketplaceId);
  return locations.map(loc => loc.key);
}

const METHODS = "POST, OPTIONS";
const DRY_RUN_DEFAULT = (process.env.EBAY_DRY_RUN || "true").toLowerCase() !== "false";
// Note: This constant is deprecated and should not be used.
// Users must configure their merchant location via /location.html
// Environment variable EBAY_MERCHANT_LOCATION_KEY is only for single-user deployments
const DEFAULT_LOCATION_KEY = ""; // No global fallback - users must set their location

type HeadersMap = Record<string, string | undefined>;

type RequestBody = {
  jobId?: string;
  groups?: any[];
};

type PreparedGroup = {
  group: any;
  mapped: TaxonomyMappedDraft;
  groupId: string;
};

function ensureJsonContentType(headers: HeadersMap) {
  const ctype = headers["content-type"] || headers["Content-Type"] || "";
  return ctype.includes("application/json");
}

function parseBody(body: string | null | undefined): RequestBody {
  if (!body) return {};
  return JSON.parse(body) as RequestBody;
}

function toGroupId(group: any): string {
  const raw = group?.groupId ?? group?.id;
  return typeof raw === "string" && raw.trim() ? raw.trim() : "";
}

function responseUnauthorized(origin: string | undefined) {
  return json(401, { error: "Unauthorized" }, origin, METHODS);
}

function responseBadRequest(origin: string | undefined, detail: Record<string, unknown>) {
  return json(400, detail, origin, METHODS);
}

export const handler: Handler = async (event) => {
  const headers = event.headers as HeadersMap;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === "OPTIONS") {
    return json(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" }, originHdr, METHODS);
  }

  if (!isOriginAllowed(originHdr)) {
    return json(403, { error: "Forbidden" }, originHdr, METHODS);
  }

  if (!ensureJsonContentType(headers)) {
    return json(415, { error: "Use application/json" }, originHdr, METHODS);
  }

  let user;
  try {
    user = await requireUserAuth(headers.authorization || headers.Authorization);
  } catch {
    return responseUnauthorized(originHdr);
  }

  // Load per-user policy defaults (if any)
  let userPolicyDefaults: { fulfillment?: string; payment?: string; return?: string; promoCampaignId?: string | null } = {};
  try {
    const store = tokensStore();
    const saved = (await store.get(userScopedKey(user.userId, "policy-defaults.json"), { type: "json" })) as any;
    if (saved && typeof saved === "object") {
      userPolicyDefaults = {
        fulfillment: typeof saved.fulfillment === "string" ? saved.fulfillment : undefined,
        payment: typeof saved.payment === "string" ? saved.payment : undefined,
        return: typeof saved.return === "string" ? saved.return : undefined,
        promoCampaignId: typeof saved.promoCampaignId === "string" ? saved.promoCampaignId : null,
      };
    }
  } catch {
    // ignore
  }

  let body: RequestBody = {};
  try {
    body = parseBody(event.body);
  } catch {
    return responseBadRequest(originHdr, { error: "Invalid JSON" });
  }

  const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
  if (!jobId) {
    return responseBadRequest(originHdr, { error: "Missing jobId" });
  }

  const groupsInput = Array.isArray(body.groups) ? body.groups : [];
  if (!groupsInput.length) {
    return responseBadRequest(originHdr, { error: "No groups provided" });
  }

  const prepared: PreparedGroup[] = [];

  for (const group of groupsInput) {
    const groupId = toGroupId(group);
    if (!groupId) {
      return responseBadRequest(originHdr, { error: "Group missing groupId", group });
    }

    let mapped: TaxonomyMappedDraft;
    try {
      mapped = await mapGroupToDraft(group, { jobId, userId: user.userId });
    } catch (err: any) {
      return json(
        400,
        {
          error: "Failed to map group",
          detail: err?.message || String(err ?? ""),
          groupId,
        },
        originHdr,
        METHODS,
      );
    }

    const missing = Array.isArray(mapped._meta?.missingRequired)
      ? mapped._meta.missingRequired.filter(Boolean)
      : [];
    if (missing.length) {
      return responseBadRequest(originHdr, {
        error: "Missing required specifics",
        missing,
        groupId,
      });
    }

    prepared.push({ group, mapped, groupId });
  }

  if (DRY_RUN_DEFAULT) {
    const previews = prepared.map(({ mapped }) => ({
      sku: mapped.sku,
      inventory: mapped.inventory,
      offer: mapped.offer,
      meta: mapped._meta,
    }));
    return json(200, { dryRun: true, count: previews.length, previews }, originHdr, METHODS);
  }

  let access;
  try {
    access = await getEbayAccessTokenStrict(user.userId);
  } catch (err: any) {
    return json(502, { error: "eBay auth failed", detail: err?.message || String(err ?? "") }, originHdr, METHODS);
  }

  // Fetch available inventory location keys once and reuse for all groups
  const marketplaceForLocations = process.env.DEFAULT_MARKETPLACE_ID || process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
  let availableLocations: { key: string; isDefault: boolean }[] = [];
  let availableLocationKeys: string[] = [];
  try {
    availableLocations = await fetchInventoryLocations(access.token, access.apiHost, marketplaceForLocations);
    availableLocationKeys = availableLocations.map(loc => loc.key);
  } catch (e: any) {
    // If fetching locations fails, continue; eBay will still error later, but we won't block here
    console.warn("[create-ebay-draft-user] failed to list locations:", e?.message || e);
  }

  const results: Array<{ sku: string; offerId: string; warnings: unknown[] }> = [];

  for (const { group, mapped, groupId } of prepared) {
    try {
      const marketplaceId =
        mapped.offer.marketplaceId || process.env.DEFAULT_MARKETPLACE_ID || process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
      let merchantLocationKey =
        (mapped.offer.merchantLocationKey && String(mapped.offer.merchantLocationKey)) || null;

      console.log(`[DEBUG] Initial merchantLocationKey from mapped: ${merchantLocationKey}`);

      // Priority order (correct for multi-user SaaS):
      // 1. User's explicit choice from the request
      // 2. User's saved default location preference
      // 3. Auto-select if only one location exists
      // 4. Environment variable fallback (should rarely be used)

      // If no explicit choice in the request, try user's saved default
      if (!merchantLocationKey) {
        try {
          const store = tokensStore();
          const saved = (await store.get(userScopedKey(user.userId, "ebay-location.json"), { type: "json" })) as any;
          const candidate = typeof saved?.merchantLocationKey === "string" ? saved.merchantLocationKey.trim() : "";
          if (candidate) {
            // Validate that the saved location still exists
            if (availableLocationKeys.includes(candidate)) {
              merchantLocationKey = candidate;
              console.log(`[DEBUG] Using user's saved default location: ${merchantLocationKey}`);
            } else {
              console.log(`[DEBUG] Saved location '${candidate}' no longer exists. Clearing and will auto-select.`);
              // Clear the invalid saved location
              await store.setJSON(userScopedKey(user.userId, "ebay-location.json"), null);
            }
          }
        } catch {
          // ignore
        }
      }
      
      // Auto-select if only one location exists
      if (!merchantLocationKey && availableLocationKeys.length === 1) {
        merchantLocationKey = availableLocationKeys[0];
        console.log(`[DEBUG] Auto-selected only available location: ${merchantLocationKey}`);
        
        // Save this as the user's default for future use
        try {
          const store = tokensStore();
          await store.setJSON(userScopedKey(user.userId, "ebay-location.json"), {
            merchantLocationKey,
            savedAt: new Date().toISOString(),
            autoSelected: true
          });
          console.log(`[DEBUG] Saved auto-selected location as user default`);
        } catch (saveErr) {
          console.warn(`[DEBUG] Failed to save auto-selected location:`, saveErr);
        }
      }
      
      // Auto-select eBay's default location if multiple exist
      if (!merchantLocationKey && availableLocations.length > 1) {
        // Find the location marked as default by eBay (WAREHOUSE type)
        const defaultLoc = availableLocations.find(loc => loc.isDefault);
        merchantLocationKey = defaultLoc ? defaultLoc.key : availableLocations[0].key;
        
        if (defaultLoc) {
          console.log(`[DEBUG] Auto-selected eBay's default location: ${merchantLocationKey}`);
        } else {
          console.log(`[DEBUG] No eBay default found, auto-selected first of ${availableLocations.length} locations: ${merchantLocationKey}`);
        }
        
        // Save this as the user's default for future use
        try {
          const store = tokensStore();
          await store.setJSON(userScopedKey(user.userId, "ebay-location.json"), {
            merchantLocationKey,
            savedAt: new Date().toISOString(),
            autoSelected: true,
            source: defaultLoc ? "ebay-default" : "first-available"
          });
          console.log(`[DEBUG] Saved auto-selected location as user default`);
        } catch (saveErr) {
          console.warn(`[DEBUG] Failed to save auto-selected location:`, saveErr);
        }
      }

      // Last resort: environment variable fallback (admin-configured default)
      // Note: This should rarely be used now that we auto-select from user's actual locations
      if (!merchantLocationKey && process.env.EBAY_MERCHANT_LOCATION_KEY) {
        merchantLocationKey = process.env.EBAY_MERCHANT_LOCATION_KEY;
        console.log(`[DEBUG] Using env variable as fallback: ${merchantLocationKey}`);
      }

      console.log(`[DEBUG] Final merchantLocationKey before validation: ${merchantLocationKey}`);

      // Resolve and validate merchantLocationKey against live locations
      const keys = Array.isArray(availableLocationKeys) ? availableLocationKeys : [];
      const findKey = (name?: string | null) => {
        if (!name) return null;
        // exact match first (case-sensitive)
        const exact = keys.find((k) => k === name);
        if (exact) return exact;
        const lower = String(name).toLowerCase();
        const ci = keys.find((k) => String(k).toLowerCase() === lower);
        return ci || null;
      };
      const resolvedKey = findKey(merchantLocationKey);
      if (!resolvedKey) {
        console.error(`[create-ebay-draft-user] Invalid merchantLocationKey: "${merchantLocationKey}" not found. Available: ${keys.join(', ')}`);
        return json(
          400,
          {
            error: "Invalid merchantLocationKey",
            detail: `Key '${merchantLocationKey || "(none)"}' not found in ${process.env.EBAY_ENV || "production"}. Please select from available locations or create a new one.`,
            invalidKey: merchantLocationKey,
            availableKeys: keys,
            groupId,
            helpUrl: "/location.html"
          },
          originHdr,
          METHODS
        );
      }
      merchantLocationKey = resolvedKey;

      console.log(`[create-ebay-draft-user] About to create inventory for SKU: ${mapped.sku}`);
      console.log(`[create-ebay-draft-user] Inventory aspects:`, JSON.stringify(mapped.inventory?.product?.aspects, null, 2));
      console.log(`[create-ebay-draft-user] Has Brand? ${!!mapped.inventory?.product?.aspects?.Brand}, Brand value:`, mapped.inventory?.product?.aspects?.Brand);

  await putInventoryItem(access.token, access.apiHost, mapped.sku, mapped.inventory, mapped.offer.quantity, marketplaceId);

      console.log(`[create-ebay-draft-user] About to create offer for SKU: ${mapped.sku}`);
      console.log(`[create-ebay-draft-user] Offer params:`, {
        categoryId: mapped.offer.categoryId,
        price: mapped.offer.price,
        quantity: mapped.offer.quantity,
        condition: mapped.offer.condition,
        fulfillmentPolicyId: mapped.offer.fulfillmentPolicyId ?? userPolicyDefaults.fulfillment ?? null,
        paymentPolicyId: mapped.offer.paymentPolicyId ?? userPolicyDefaults.payment ?? null,
        returnPolicyId: mapped.offer.returnPolicyId ?? userPolicyDefaults.return ?? null,
        merchantLocationKey,
      });

      let offerResult;
      try {
        offerResult = await createOffer(access.token, access.apiHost, {
        sku: mapped.sku,
        marketplaceId,
        categoryId: mapped.offer.categoryId,
        price: mapped.offer.price,
        quantity: mapped.offer.quantity,
        condition: mapped.offer.condition,
        fulfillmentPolicyId: mapped.offer.fulfillmentPolicyId ?? userPolicyDefaults.fulfillment ?? null,
        paymentPolicyId: mapped.offer.paymentPolicyId ?? userPolicyDefaults.payment ?? null,
        returnPolicyId: mapped.offer.returnPolicyId ?? userPolicyDefaults.return ?? null,
        merchantLocationKey,
        description: mapped.offer.description,
        merchantData: {
          ...(group.pricingStatus || group.priceMeta ? {
            pricingStatus: group.pricingStatus,
            priceMeta: group.priceMeta,
          } : {}),
          // Include promotion settings from draft
          ...(group.promotion?.enabled ? {
            autoPromote: true,
            autoPromoteAdRate: group.promotion.rate || 5, // Default to 5% if not specified
          } : {
            autoPromote: false,
            autoPromoteAdRate: null,
          }),
        },
        });
        console.log(`[create-ebay-draft-user] Promotion data for ${mapped.sku}:`, {
          hasPromotion: !!group.promotion,
          promotionEnabled: group.promotion?.enabled,
          promotionRate: group.promotion?.rate,
          merchantDataAutoPromote: group.promotion?.enabled ? true : false,
          merchantDataAutoPromoteAdRate: group.promotion?.enabled ? (group.promotion.rate || 5) : null
        });
        console.log(`[create-ebay-draft-user] ✓ Offer created successfully for SKU: ${mapped.sku}, offerId: ${offerResult.offerId}`);
        
        // Apply promotion if enabled
        if (group.promotion?.enabled) {
          try {
            console.log(`[create-ebay-draft-user] Applying promotion to ${mapped.sku} at ${group.promotion.rate || 5}%...`);
            
            // Create token cache implementation for promoteSingleListing
            const promoteTokenCache = {
              async get(userId: string): Promise<string | null> {
                return userId === user.userId ? access.token : null;
              },
              async set(_userId: string, _token: string, _expiresIn: number): Promise<void> {
                // No-op: we already have the token
              }
            };
            
            const promoResult = await promoteSingleListing({
              tokenCache: promoteTokenCache,
              userId: user.userId,
              ebayAccountId: user.userId, // Use userId as accountId for default account
              inventoryReferenceId: mapped.sku,
              adRate: group.promotion.rate || 5,
              campaignIdOverride: undefined,
            });
            
            console.log(`[create-ebay-draft-user] ✓ Promotion applied to ${mapped.sku}: campaign=${promoResult.campaignId}, enabled=${promoResult.enabled}`);
          } catch (promoErr: any) {
            console.error(`[create-ebay-draft-user] ⚠️ Failed to promote ${mapped.sku}:`, promoErr?.message || promoErr);
            // Don't fail the whole job - promotion is optional
          }
        }
      } catch (e: any) {
        const msg = String(e?.message || e || "");
        // Handle idempotency: offer already exists (errorId 25002)
        if (/\berrorId\"?\s*:\s*25002\b/.test(msg)) {
          console.log(`[create-ebay-draft-user] ℹ Offer already exists for SKU: ${mapped.sku}, attempting to fetch existing offer...`);
          let existingOfferId = "";
          try {
            // Attempt to parse offerId from the error JSON
            const jsonStart = msg.indexOf("{");
            if (jsonStart >= 0) {
              const jsonText = msg.slice(jsonStart);
              const parsed = JSON.parse(jsonText);
              const errs = Array.isArray(parsed?.errors) ? parsed.errors : [];
              const first = errs[0] || {};
              const params = Array.isArray(first.parameters) ? first.parameters : [];
              const p = params.find((x: any) => String(x?.name || "") === "offerId");
              if (p && typeof p.value === "string" && p.value.trim()) existingOfferId = p.value.trim();
            }
          } catch {
            // ignore parse failure
          }
          if (existingOfferId) {
            try {
              const off = await fetchOfferById(access.token, access.apiHost, existingOfferId, marketplaceId);
              console.log(`[create-ebay-draft-user] ✓ Fetched existing offer for SKU: ${mapped.sku}, offerId: ${existingOfferId}, status: ${off?.status || 'UNKNOWN'}`);
              results.push({ sku: mapped.sku, offerId: existingOfferId, warnings: [], ...(off?.status ? { status: off.status } : {}) });
              try {
                await putBinding(user.userId, jobId, groupId, {
                  sku: mapped.sku,
                  offerId: existingOfferId,
                  jobId,
                  groupId,
                  warnings: [],
                  createdAt: Date.now(),
                });
              } catch (bindErr) {
                console.warn("[create-ebay-draft-user] failed to persist binding (existing)", bindErr);
              }
              // Proceed to next group without treating as error
              continue;
            } catch (fetchErr: any) {
              // If fetching fails, still return a graceful error below
              console.warn("[create-ebay-draft-user] idempotent fetch failed", fetchErr?.message || fetchErr);
            }
          }
        }
        // Non-idempotent or unhandled error: log and bubble up
        console.error(`[create-ebay-draft-user] ✗ Offer creation failed for SKU: ${mapped.sku}:`, e?.message || e);
        throw e;
      }

      // Push success; include status if we have it in raw response
      const status = (offerResult as any)?.raw?.offer?.status || (offerResult as any)?.raw?.status || undefined;
      results.push({ sku: mapped.sku, offerId: offerResult.offerId, warnings: offerResult.warnings, ...(status ? { status } : {}) });

      try {
        await putBinding(user.userId, jobId, groupId, {
          sku: mapped.sku,
          offerId: offerResult.offerId,
          jobId,
          groupId,
          warnings: offerResult.warnings,
          createdAt: Date.now(),
        });
      } catch (bindErr) {
        console.warn("[create-ebay-draft-user] failed to persist binding", bindErr);
      }
    } catch (err: any) {
      return json(
        502,
        {
          error: "Failed to create eBay draft",
          detail: err?.message || String(err ?? ""),
          groupId,
        },
        originHdr,
        METHODS,
      );
    }
  }

  console.log(
    JSON.stringify({
      evt: "create-ebay-draft-user.success",
      userId: user.userId,
      jobId,
      created: results.length,
    }),
  );

  return json(200, { ok: true, created: results.length, results }, originHdr, METHODS);
};
