import type { Handler } from "@netlify/functions";
import { accessTokenFromRefresh, tokenHosts } from "./_common.js";
import { tokensStore } from "./_blobs.js";

export const handler: Handler = async (event) => {
  try {
    const sku = event.queryStringParameters?.sku;
    const limit = Number(event.queryStringParameters?.limit || 20);
    const status = event.queryStringParameters?.status; // e.g., DRAFT, PUBLISHED
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

    async function listOnce(includeStatus: boolean){
      const params = new URLSearchParams();
      if (sku) params.set("sku", sku);
      if (includeStatus && status) params.set("offer_status", status);
      // marketplace_id is required by eBay for listing offers reliably
      params.set("marketplace_id", MARKETPLACE_ID);
      params.set("limit", String(limit));
      const url = `${apiHost}/sell/inventory/v1/offer?${params.toString()}`;
      const r = await fetch(url, { headers });
      const txt = await r.text();
      let json: any; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
      return { ok: r.ok, status: r.status, url, body: json };
    }
    let first = await listOnce(true);
    if (!first.ok && status) {
      // Retry without unsupported filter and filter client-side
      const second = await listOnce(false);
      if (!second.ok) return { statusCode: second.status, body: JSON.stringify({ error: "list-offers failed", attempt: [first, second] }) };
      const offers = Array.isArray(second.body?.offers) ? second.body.offers : [];
      const filtered = offers.filter((o: any) => String(o?.status || '').toUpperCase() === String(status).toUpperCase());
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, total: filtered.length, offers: filtered }) };
    }
    if (!first.ok) return { statusCode: first.status, body: JSON.stringify({ error: "list-offers failed", attempt: [first] }) };
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, ...first.body }) };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: "list-offers error", detail: e?.message || String(e) }) };
  }
};
