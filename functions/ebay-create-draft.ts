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
      return { statusCode: 405, body: JSON.stringify({ error: "method not allowed" }) };
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
      return { statusCode: 400, body: JSON.stringify({ error: "Missing sku|title|price|image" }) };
    }

    // Use the connected user's stored refresh token
    const store = tokensStore();
    const saved = await store.get('ebay.json', { type: 'json' }) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) return { statusCode: 400, body: JSON.stringify({ error: "Connect eBay first" }) };
    const { access_token } = await accessTokenFromRefresh(refresh);

    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const mlk = process.env.EBAY_MERCHANT_LOCATION_KEY || "default-loc";

    // 1) Upsert Inventory Item
    const invPayload = {
      sku,
      product: { title, description, imageUrls: images ?? [primaryImage] },
      availability: { shipToLocationAvailability: { quantity: qty } },
    } as any;

    let r = await fetch(`${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(invPayload),
    });
    if (!r.ok) {
      const t = await r.text();
      return { statusCode: r.status, body: `inventory put failed: ${t}` };
    }

    // 2) Use first available business policies
    async function pickFirst(path: string): Promise<string | null> {
      const res = await fetch(`${apiHost}${path}`, { headers: { Authorization: `Bearer ${access_token}` } });
      const json = (await res.json()) as any;
      const list = json.fulfillmentPolicies || json.paymentPolicies || json.returnPolicies || [];
      return list.length ? list[0].id : null;
    }
    const fulfillmentPolicyId = await pickFirst("/sell/account/v1/fulfillment_policy");
    const paymentPolicyId = await pickFirst("/sell/account/v1/payment_policy");
    const returnPolicyId = await pickFirst("/sell/account/v1/return_policy");

    if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
      return { statusCode: 400, body: JSON.stringify({ error: "No business policies found. Create payment/fulfillment/return policies first." }) };
    }

    // 3) Create Offer (DRAFT)
    const offerPayload = {
      sku,
      marketplaceId: "EBAY_US",
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
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(offerPayload),
    });
    const offerRes = await r.json();
    if (!r.ok) return { statusCode: r.status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(offerRes) };

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, draftOffer: offerRes }) };
  } catch (e: any) {
    return { statusCode: 500, body: `create-draft error: ${e.message}` };
  }
};
