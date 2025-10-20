import type { Handler } from "@netlify/functions";
import { accessTokenFromRefresh, tokenHosts } from "./_common.js";
import { tokensStore } from "./_blobs.js";

export const handler: Handler = async (event) => {
  try {
    const sku = event.queryStringParameters?.sku;
    const limit = Number(event.queryStringParameters?.limit || 20);
    const status = event.queryStringParameters?.status; // e.g., DRAFT, PUBLISHED
    const offset = Number(event.queryStringParameters?.offset || 0);
    const store = tokensStore();
    const saved = (await store.get("ebay.json", { type: "json" })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) return { statusCode: 400, body: JSON.stringify({ error: "Connect eBay first" }) };
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

    async function listOnce(includeStatus: boolean, includeMarketplace: boolean){
      const params = new URLSearchParams();
      if (sku) params.set("sku", sku);
      if (includeStatus && status) params.set("offer_status", status);
      if (includeMarketplace) params.set("marketplace_id", MARKETPLACE_ID);
      params.set("limit", String(limit));
      params.set("offset", String(offset));
      const url = `${apiHost}/sell/inventory/v1/offer?${params.toString()}`;
      const r = await fetch(url, { headers });
      const txt = await r.text();
      let json: any; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
      return { ok: r.ok, status: r.status, url, body: json };
    }
    const attempts: any[] = [];

    // 1) Try with status + marketplace
    let res = await listOnce(true, true); attempts.push(res);
    // If failure with status present, try without status (some accounts/APIs reject offer_status)
    if (!res.ok && status) {
      res = await listOnce(false, true); attempts.push(res);
    }
    // If still bad (e.g., 400 invalid SKU spurious), try without marketplace_id
    if (!res.ok) {
      res = await listOnce(false, false); attempts.push(res);
    }

    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: "list-offers failed", attempt: attempts }) };
    }

    // Success path
    const body = res.body || {};
    const offers = Array.isArray(body.offers) ? body.offers : [];
    // If we removed the status filter, apply client-side filtering now
    const final = status ? offers.filter((o: any) => String(o?.status||'').toUpperCase() === String(status).toUpperCase()) : offers;
    if (res.url.includes("offer_status=") && body.offers) {
      // Already filtered by server; return upstream shape
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, ...body }) };
    }
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, total: final.length, offers: final, href: body.href, next: body.next, prev: body.prev }) };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: "list-offers error", detail: e?.message || String(e) }) };
  }
};
