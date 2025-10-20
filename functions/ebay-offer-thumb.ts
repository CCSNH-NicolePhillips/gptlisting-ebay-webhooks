import type { Handler } from "@netlify/functions";
import { accessTokenFromRefresh, tokenHosts } from "./_common.js";
import { tokensStore } from "./_blobs.js";

export const handler: Handler = async (event) => {
  try {
    const offerId = event.queryStringParameters?.offerId || event.queryStringParameters?.id;
    if (!offerId) return { statusCode: 400, body: "Missing offerId" };

    const store = tokensStore();
    const saved = (await store.get("ebay.json", { type: "json" })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) return { statusCode: 401, body: "Connect eBay first" };
    const { access_token } = await accessTokenFromRefresh(refresh);

    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
    const headers = {
      Authorization: `Bearer ${access_token}`,
      Accept: "application/json",
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
    } as Record<string, string>;

    // 1) Get offer
    const offerUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
    let r = await fetch(offerUrl, { headers });
    if (!r.ok) return { statusCode: r.status, body: `offer fetch failed: ${r.status}` };
    const offer = await r.json();
    const skuRaw: string | undefined = offer?.sku;
    if (!skuRaw) return { statusCode: 204 };

    // 2) Try inventory item by sku and sanitized sku
    const trySkus = [skuRaw];
    const san = skuRaw.replace(/[^A-Za-z0-9]/g, '').slice(0,50);
    if (san && san !== skuRaw) trySkus.push(san);

    let imageUrl: string | undefined;
    for (const s of trySkus) {
      const invUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(s)}`;
      const ir = await fetch(invUrl, { headers });
      if (!ir.ok) continue;
      const item = await ir.json();
      const imgs = item?.product?.imageUrls || item?.product?.images || item?.product?.image || [];
      const arr = Array.isArray(imgs) ? imgs : (imgs ? [imgs] : []);
      if (arr.length) { imageUrl = arr[0]; break; }
    }
    if (!imageUrl) return { statusCode: 204 };

    // 3) Fetch and stream image back with correct headers
    const upstream = await fetch(imageUrl, { redirect: "follow" });
    if (!upstream.ok) return { statusCode: upstream.status, body: `image fetch failed: ${upstream.status}` };
    const type = (upstream.headers.get("content-type") || '').toLowerCase();
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (!type.startsWith('image/')) return { statusCode: 415, body: `Not an image (type=${type})` };
    return {
      statusCode: 200,
      headers: {
        "Content-Type": type,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      },
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e: any) {
    return { statusCode: 500, body: `offer-thumb error: ${e?.message || String(e)}` };
  }
};
