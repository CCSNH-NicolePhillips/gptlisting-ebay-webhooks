import type { Handler } from "@netlify/functions";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, isOriginAllowed, json } from "../../src/lib/http.js";
import { mapGroupToDraft, type TaxonomyMappedDraft } from "../../src/lib/map-group-to-draft.js";
import { putBinding } from "../../src/lib/bind-store.js";
import { getEbayAccessTokenStrict } from "../../src/lib/ebay-auth.js";
import { tokensStore } from "../../src/lib/_blobs.js";
import { userScopedKey } from "../../src/lib/_auth.js";
import { createOffer, putInventoryItem } from "../../src/lib/ebay-sell.js";

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

async function fetchInventoryLocationKeys(accessToken: string, apiHost: string, marketplaceId: string): Promise<string[]> {
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
    const keys: string[] = [];
    for (const loc of list) {
      const k = typeof loc?.merchantLocationKey === "string" ? loc.merchantLocationKey : null;
      if (k) keys.push(k);
    }
    return keys;
  } catch {
    return [];
  }
}

const METHODS = "POST, OPTIONS";
const DRY_RUN_DEFAULT = (process.env.EBAY_DRY_RUN || "true").toLowerCase() !== "false";

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
  let userPolicyDefaults: { fulfillment?: string; payment?: string; return?: string } = {};
  try {
    const store = tokensStore();
    const saved = (await store.get(userScopedKey(user.userId, "policy-defaults.json"), { type: "json" })) as any;
    if (saved && typeof saved === "object") {
      userPolicyDefaults = {
        fulfillment: typeof saved.fulfillment === "string" ? saved.fulfillment : undefined,
        payment: typeof saved.payment === "string" ? saved.payment : undefined,
        return: typeof saved.return === "string" ? saved.return : undefined,
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
  let availableLocationKeys: string[] = [];
  try {
    availableLocationKeys = await fetchInventoryLocationKeys(access.token, access.apiHost, marketplaceForLocations);
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
        (mapped.offer.merchantLocationKey && String(mapped.offer.merchantLocationKey)) || process.env.EBAY_MERCHANT_LOCATION_KEY || null;

      // Per-user default merchant location fallback
      if (!merchantLocationKey) {
        try {
          const store = tokensStore();
          const saved = (await store.get(userScopedKey(user.userId, "ebay-location.json"), { type: "json" })) as any;
          const candidate = typeof saved?.merchantLocationKey === "string" ? saved.merchantLocationKey.trim() : "";
          if (candidate) merchantLocationKey = candidate;
        } catch {
          // ignore
        }
      }

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
        return json(
          400,
          {
            error: "Invalid merchantLocationKey",
            detail: `Key '${merchantLocationKey || "(none)"}' not found in ${process.env.EBAY_ENV || "production"}.`,
            availableKeys: keys,
            groupId,
          },
          originHdr,
          METHODS
        );
      }
      merchantLocationKey = resolvedKey;

  await putInventoryItem(access.token, access.apiHost, mapped.sku, mapped.inventory, mapped.offer.quantity, marketplaceId);

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
        });
      } catch (e: any) {
        const msg = String(e?.message || e || "");
        // Handle idempotency: offer already exists (errorId 25002)
        if (/\berrorId\"?\s*:\s*25002\b/.test(msg)) {
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
        // Non-idempotent or unhandled error: bubble up
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
