import type { Handler } from "@netlify/functions";
import { accessTokenFromRefresh, tokenHosts } from "./_common.js";
import { tokensStore } from "./_blobs.js";

/**
 * Creates Inventory Item + DRAFT Offer (unpublished)
 * Method: POST
 * Body (JSON): { sku, title, price, image?|images?: string|string[], qty?, categoryId?, description? }
 */
export const handler: Handler = async (event) => {
  try {
    // Accept GET query for quick testing; POST body is canonical
    const qs = (event.queryStringParameters || {}) as Record<string, string>;
    const body = event.body ? (JSON.parse(event.body) as any) : {};
    const sku = (body.sku ?? qs["sku"]) as string | undefined;
    const title = (body.title ?? qs["title"]) as string | undefined;
    const price = body.price !== undefined ? (typeof body.price === "number" ? body.price : parseFloat(body.price)) : (qs["price"] ? parseFloat(qs["price"]) : undefined);
    const image = (body.image ?? qs["image"]) as string | undefined;
    const images = (Array.isArray(body.images) ? body.images : (qs["images"] ? String(qs["images"]).split(",") : undefined)) as string[] | undefined;
    const qty = body.qty ? Number(body.qty) : (qs["qty"] ? Number(qs["qty"]) : 1);
  const categoryId = (body.categoryId ?? qs["categoryId"]) as string | undefined;
  const condition = (body.condition ?? qs["condition"]) as string | number | undefined;
  const aspects = (body.aspects ?? (qs["aspects"] ? JSON.parse(qs["aspects"]) : undefined)) as Record<string, string | string[]> | undefined;
    const description = ((body.description as string | undefined) ?? qs["description"] ?? title) as string | undefined;
    const overrideFulfillment = ((body.fulfillmentPolicyId as string | undefined) ?? (qs["fulfillmentPolicyId"] as string | undefined)) || undefined;
    const overridePayment = ((body.paymentPolicyId as string | undefined) ?? (qs["paymentPolicyId"] as string | undefined)) || undefined;
    const overrideReturns = ((body.returnPolicyId as string | undefined) ?? (qs["returnPolicyId"] as string | undefined)) || undefined;
    const overrideLocationKey = ((body.merchantLocationKey as string | undefined) ?? (qs["merchantLocationKey"] as string | undefined)) || undefined;

    const primaryImage = image || images?.[0];
    if (!sku || !title || !primaryImage || !Number.isFinite(price)) {
      return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Missing sku|title|price|image" }) };
    }

    // Use the connected user's stored refresh token
    const store = tokensStore();
    const saved = await store.get('ebay.json', { type: 'json' }) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) return { statusCode: 400, body: JSON.stringify({ error: "Connect eBay first" }) };
    const { access_token } = await accessTokenFromRefresh(refresh);

  const ENV = process.env.EBAY_ENV || "PROD";
  const { apiHost } = tokenHosts(ENV);
    // Normalize and pick merchant location key
    const mlkRaw = overrideLocationKey || process.env.EBAY_MERCHANT_LOCATION_KEY || "default-loc";
    const mlk = String(mlkRaw).trim().replace(/\s+/g, "-");
  const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
    const commonHeaders = {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
    } as Record<string, string>;

    // 1) Upsert Inventory Item
    const mapCondToInventory = (c?: number) => {
      switch (c) {
        case 1000: return "NEW";
        case 1500: return "NEW_OTHER";
        case 1750: return "NEW_OTHER"; // map to NEW_OTHER
        case 2000: return "MANUFACTURER_REFURBISHED";
        case 2500: return "SELLER_REFURBISHED";
        case 3000: return "USED";
        case 7000: return "FOR_PARTS_OR_NOT_WORKING";
        default: return undefined;
      }
    };
    const condNumForInv = (condition !== undefined && Number.isFinite(Number(condition))) ? Number(condition) : undefined;
    const invCond = mapCondToInventory(condNumForInv);
    const invPayload = {
      sku,
      product: { title, description, imageUrls: images ?? [primaryImage] },
      availability: { shipToLocationAvailability: { quantity: qty } },
      // Set condition on inventory item as string enum when available (offer will also carry numeric condition)
      condition: invCond,
      aspects: undefined,
    } as any;
    if (aspects && typeof aspects === 'object') {
      // Inventory API expects aspects as: { [name]: string[] }
      const norm: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(aspects)) {
        if (Array.isArray(v)) {
          const arr = v.map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
          if (arr.length) norm[k] = arr;
        } else if (v != null) {
          const s = String(v).trim();
          if (s) norm[k] = [s];
        }
      }
      if (Object.keys(norm).length) invPayload.product.aspects = norm; // inventory_item product.aspects
    }

    const invUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
    let r = await fetch(invUrl, {
      method: "PUT",
      headers: commonHeaders,
      body: JSON.stringify(invPayload),
    });
    if (!r.ok) {
      let detail: any = undefined;
      try { detail = await r.json(); } catch { detail = await r.text(); }
      return { statusCode: r.status, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "inventory put failed", step: "put-inventory-item", url: invUrl, status: r.status, payload: invPayload, detail }) };
    }

    // 2) Verify Inventory Location exists
    const locUrl = `${apiHost}/sell/inventory/v1/location/${encodeURIComponent(mlk)}`;
    const locRes = await fetch(locUrl, { headers: commonHeaders });
    if (locRes.status === 404) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "missing-location",
          detail: {
            message: `Inventory location '${mlk}' not found. Initialize it before creating offers.`,
            initUrl: "/.netlify/functions/ebay-init-location",
            checkUrl: locUrl,
          },
        }),
      };
    }
    if (!locRes.ok) {
      let ldetail: any = undefined;
      try { ldetail = await locRes.json(); } catch { ldetail = await locRes.text(); }
      return { statusCode: locRes.status, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "location check failed", step: "get-location", url: locUrl, status: locRes.status, detail: ldetail }) };
    }

    // 3) Use first available business policies
    async function pickPolicy(path: string, preferNames?: string[]): Promise<string | null> {
      const url = `${apiHost}${path}?marketplace_id=${MARKETPLACE_ID}`;
      const res = await fetch(url, { headers: commonHeaders });
      const json = (await res.json()) as any;
      const list = json.fulfillmentPolicies || json.paymentPolicies || json.returnPolicies || [];
      if (!Array.isArray(list) || list.length === 0) return null;
      if (preferNames && preferNames.length) {
        for (const nm of preferNames) {
          const found = list.find((p: any) => (p?.name || "").toLowerCase() === nm.toLowerCase());
          if (found) {
            const pid = found.id || found.fulfillmentPolicyId || found.paymentPolicyId || found.returnPolicyId;
            if (pid) return pid as string;
          }
        }
      }
      const first = list[0];
      const pid = first?.id || first?.fulfillmentPolicyId || first?.paymentPolicyId || first?.returnPolicyId;
      return pid || null;
    }
    const fulfillmentPolicyId = await pickPolicy("/sell/account/v1/fulfillment_policy", ["Default Shipping (Auto)"]);
    const paymentPolicyId = await pickPolicy("/sell/account/v1/payment_policy", ["Default Payment (Auto)"]);
    const returnPolicyId = await pickPolicy("/sell/account/v1/return_policy", ["No Returns (Auto)", "Default Returns (Auto)"]);

    if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
      const hint = {
        message:
          "No business policies available. This account may not be opted into Business Policies or none exist for the selected marketplace.",
        nextSteps: [
          "Open https://www.ebay.com/sh/str/selling-policies and opt in to Business policies",
          `Create Payment, Return, and Shipping policies for marketplace ${MARKETPLACE_ID}`,
        ],
      };
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "missing-policies", detail: hint, marketplaceId: MARKETPLACE_ID }),
      };
    }

  // 4) Create Offer (DRAFT)
    const offerPayload = {
      sku,
      marketplaceId: MARKETPLACE_ID,
      format: "FIXED_PRICE",
      availableQuantity: qty,
      categoryId: categoryId || "31413",
      listingDescription: description,
      pricingSummary: { price: { currency: "USD", value: price.toFixed(2) } },
      listingPolicies: { fulfillmentPolicyId: overrideFulfillment || fulfillmentPolicyId, paymentPolicyId: overridePayment || paymentPolicyId, returnPolicyId: overrideReturns || returnPolicyId },
      merchantLocationKey: mlk,
    };
    // Include condition on offer if provided (ensure numeric)
    if (condition !== undefined) {
      const condNum = Number(condition);
      if (Number.isFinite(condNum)) (offerPayload as any).condition = condNum;
    }

    const offerUrl = `${apiHost}/sell/inventory/v1/offer`;
    r = await fetch(offerUrl, {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify(offerPayload),
    });
    const offerText = await r.text();
    let offerRes: any;
    try { offerRes = JSON.parse(offerText); } catch { offerRes = { raw: offerText }; }
    if (!r.ok) return { statusCode: r.status, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "offer create failed", step: "post-offer", url: offerUrl, status: r.status, payload: offerPayload, detail: offerRes }) };

    // 4b) Verify the offer actually exists and is DRAFT (avoid reporting success prematurely)
    const createdOfferId = offerRes?.offerId || offerRes?.offer?.offerId;
    if (!createdOfferId) {
      return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "offer missing id after create", step: "verify-offer", detail: offerRes }) };
    }
    const getOffer = async () => {
      const url = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(createdOfferId)}`;
      const res = await fetch(url, { headers: commonHeaders });
      const txt = await res.text();
      let json: any; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
      return { ok: res.ok, status: res.status, body: json, url };
    };
    // retry a couple times in case of indexing delay
    let verified = await getOffer();
    if (!verified.ok || !verified.body) { await new Promise(r => setTimeout(r, 400)); verified = await getOffer(); }
    if (!verified.ok || !verified.body) {
      return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "offer verification failed", step: "verify-offer", offerId: createdOfferId, verify: { status: verified.status, url: verified.url, body: verified.body } }) };
    }
    const status = verified.body?.status;
    if (status === "DRAFT" || status === "UNPUBLISHED") {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, env: ENV, marketplaceId: MARKETPLACE_ID, draftOffer: verified.body, status }) };
    }
    // Treat any other status as failure for this flow; surface full offer for debugging
    return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "unexpected-offer-status", step: "verify-offer", offerId: createdOfferId, status, offer: verified.body }) };
  } catch (e: any) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "create-draft error", detail: e?.message || String(e) }) };
  }
};
