import type { Handler } from "@netlify/functions";
import { accessTokenFromRefresh, tokenHosts } from "./_common.js";

/** Creates Inventory Item + DRAFT Offer (unpublished)
 *  Query: sku, title, price, image, qty?, categoryId?
 */
export const handler: Handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};
    const sku = q.sku;
    const title = q.title;
    const price = q.price ? parseFloat(q.price) : NaN;
    const image = q.image;
    const qty = q.qty ? Number(q.qty) : 1;

    if (!sku || !title || !image || !Number.isFinite(price)) {
      return { statusCode: 400, body: "Missing sku|title|price|image" };
    }

    const refresh = process.env.EBAY_TEST_REFRESH_TOKEN;
    if (!refresh) return { statusCode: 400, body: "Set EBAY_TEST_REFRESH_TOKEN first." };
    const { access_token } = await accessTokenFromRefresh(refresh);

    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const mlk = process.env.EBAY_MERCHANT_LOCATION_KEY || "default-loc";

    // 1) Upsert Inventory Item
    const invPayload = {
      sku,
      product: { title, description: title, imageUrls: [image] },
      availability: { shipToLocationAvailability: { quantity: qty } },
    };

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
      return { statusCode: 400, body: "No business policies found. Create payment/fulfillment/return policies first." };
    }

    // 3) Create Offer (DRAFT)
    const offerPayload = {
      sku,
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      availableQuantity: qty,
      categoryId: q.categoryId || "31413",
      listingDescription: title,
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
    if (!r.ok) return { statusCode: r.status, body: JSON.stringify(offerRes) };

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, draftOffer: offerRes }) };
  } catch (e: any) {
    return { statusCode: 500, body: `create-draft error: ${e.message}` };
  }
};
