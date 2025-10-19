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
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "method not allowed" }) };
    }

    const body = event.body ? JSON.parse(event.body) as any : {};
    const sku = body.sku as string | undefined;
    const title = body.title as string | undefined;
    const price = typeof body.price === "number" ? body.price : parseFloat(body.price);
    const image = body.image as string | undefined;
    const images = (Array.isArray(body.images) ? body.images : undefined) as string[] | undefined;
    const qty = body.qty ? Number(body.qty) : 1;
    const categoryId = body.categoryId as string | undefined;
    const description = (body.description as string | undefined) || title;

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

    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const mlk = process.env.EBAY_MERCHANT_LOCATION_KEY || "default-loc";
  const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
    const commonHeaders = {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json",
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
    } as Record<string, string>;

    // 1) Upsert Inventory Item
    const invPayload = {
      sku,
      product: { title, description, imageUrls: images ?? [primaryImage] },
      availability: { shipToLocationAvailability: { quantity: qty } },
    } as any;

    let r = await fetch(`${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
      method: "PUT",
      headers: commonHeaders,
      body: JSON.stringify(invPayload),
    });
    if (!r.ok) {
      let detail: any = undefined;
      try { detail = await r.json(); } catch { detail = await r.text(); }
      return { statusCode: r.status, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "inventory put failed", detail }) };
    }

    // 2) Use first available business policies
    async function pickPolicy(path: string, preferName?: string): Promise<string | null> {
      const url = `${apiHost}${path}?marketplace_id=${MARKETPLACE_ID}`;
      const res = await fetch(url, { headers: commonHeaders });
      const json = (await res.json()) as any;
      const list = json.fulfillmentPolicies || json.paymentPolicies || json.returnPolicies || [];
      if (!Array.isArray(list) || list.length === 0) return null;
      if (preferName) {
        const found = list.find((p: any) => (p?.name || "").toLowerCase() === preferName.toLowerCase());
        if (found?.id) return found.id;
      }
      return list[0].id || null;
    }
    const fulfillmentPolicyId = await pickPolicy("/sell/account/v1/fulfillment_policy", "Default Shipping (Auto)");
    const paymentPolicyId = await pickPolicy("/sell/account/v1/payment_policy", "Default Payment (Auto)");
    const returnPolicyId = await pickPolicy("/sell/account/v1/return_policy", "Default Returns (Auto)");

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

    // 3) Create Offer (DRAFT)
    const offerPayload = {
      sku,
  marketplaceId: MARKETPLACE_ID,
      format: "FIXED_PRICE",
      availableQuantity: qty,
      categoryId: categoryId || "31413",
      listingDescription: description,
      pricingSummary: { price: { currency: "USD", value: price.toFixed(2) } },
      listingPolicies: { fulfillmentPolicyId, paymentPolicyId, returnPolicyId },
      merchantLocationKey: mlk,
      tax: { applyTax: false },
    };

    r = await fetch(`${apiHost}/sell/inventory/v1/offer`, {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify(offerPayload),
    });
    const offerRes = await r.json();
  if (!r.ok) return { statusCode: r.status, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "offer create failed", detail: offerRes }) };

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, draftOffer: offerRes }) };
  } catch (e: any) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "create-draft error", detail: e?.message || String(e) }) };
  }
};
