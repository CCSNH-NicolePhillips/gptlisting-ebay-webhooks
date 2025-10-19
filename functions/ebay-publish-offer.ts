import type { Handler } from "@netlify/functions";
import { accessTokenFromRefresh, tokenHosts } from "./_common.js";
import { tokensStore } from "./_blobs.js";

export const handler: Handler = async (event) => {
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const offerId = event.queryStringParameters?.offerId || body.offerId;
    if (!offerId) return { statusCode: 400, body: JSON.stringify({ error: "missing offerId" }) };
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
      "Content-Language": "en-US",
      "Accept-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
      "Content-Type": "application/json",
    } as Record<string, string>;

    const url = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`; // DRAFT->ACTIVE
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({}) });
    const txt = await r.text();
    let json: any; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    if (!r.ok) return { statusCode: r.status, body: JSON.stringify({ error: "publish failed", url, status: r.status, detail: json }) };
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, result: json }) };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: "publish-offer error", detail: e?.message || String(e) }) };
  }
};
