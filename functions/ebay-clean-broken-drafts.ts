import type { Handler } from "@netlify/functions";
import { accessTokenFromRefresh, tokenHosts } from "./_common.js";
import { tokensStore } from "./_blobs.js";

type J = Record<string, any>;

export const handler: Handler = async (event) => {
  try {
    const qp = event.queryStringParameters || {} as any;
    const dryRun = /^1|true|yes$/i.test(String(qp.dryRun || qp.dry || "false"));
    const deleteAllUnpublished = /^1|true|yes$/i.test(String(qp.deleteAll || qp.all || "false"));
    const deleteInventory = /^1|true|yes$/i.test(String(qp.deleteInventory || qp.inv || "false"));

    const store = tokensStore();
    const saved = (await store.get("ebay.json", { type: "json" })) as J | null;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) return { statusCode: 400, body: JSON.stringify({ error: "Connect eBay first" }) };
    const { access_token } = await accessTokenFromRefresh(refresh);

    const ENV = process.env.EBAY_ENV || "PROD";
    const { apiHost } = tokenHosts(ENV);
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
    const headers = {
      Authorization: `Bearer ${access_token}`,
      Accept: "application/json",
      "Content-Language": "en-US",
      "Accept-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
      "Content-Type": "application/json",
    } as Record<string, string>;

    const results = { mode: { dryRun, deleteAllUnpublished, deleteInventory }, deletedOffers: [] as any[], deletedInventory: [] as any[], errors: [] as any[], attempts: [] as any[] };

    const validSku = (s?: string) => !!s && /^[A-Za-z0-9]{1,50}$/.test(s);

    async function listOffersAttempt(params: URLSearchParams) {
      const url = `${apiHost}/sell/inventory/v1/offer?${params.toString()}`;
      const r = await fetch(url, { headers });
      const t = await r.text();
      let j: any; try { j = JSON.parse(t); } catch { j = { raw: t }; }
      results.attempts.push({ status: r.status, url, body: j });
      return { ok: r.ok, status: r.status, body: j, url };
    }

    async function tryListOffers(): Promise<any[] | null> {
      const combos = [
        { offer_status: "UNPUBLISHED", marketplace: true },
        { offer_status: undefined, marketplace: true },
        { offer_status: undefined, marketplace: false },
      ];
      for (const c of combos) {
        const p = new URLSearchParams();
        if (c.offer_status) p.set("offer_status", c.offer_status);
        if (c.marketplace) p.set("marketplace_id", MARKETPLACE_ID);
        p.set("limit", "200"); p.set("offset", "0");
        const res = await listOffersAttempt(p);
        const code = Number(res.body?.errors?.[0]?.errorId || 0);
        if (res.ok) return Array.isArray(res.body?.offers) ? res.body.offers : [];
        if (res.status >= 500) continue; // try next combo
        if (res.status === 400 && code === 25707) continue; // invalid sku noise
      }
      return null;
    }

    async function deleteOffer(offerId: string) {
      const url = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
      if (dryRun) { results.deletedOffers.push({ offerId, dryRun: true }); return true; }
      const r = await fetch(url, { method: "DELETE", headers });
      if (r.ok) { results.deletedOffers.push({ offerId }); return true; }
      const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = { raw: t }; }
      results.errors.push({ action: "delete-offer", offerId, url, status: r.status, body: j });
      return false;
    }

    async function deleteInventoryItem(sku: string) {
      const url = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
      if (!deleteInventory) return false;
      if (dryRun) { results.deletedInventory.push({ sku, dryRun: true }); return true; }
      const r = await fetch(url, { method: "DELETE", headers });
      if (r.ok) { results.deletedInventory.push({ sku }); return true; }
      const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = { raw: t }; }
      results.errors.push({ action: "delete-inventory", sku, url, status: r.status, body: j });
      return false;
    }

    // Strategy A: try to list offers directly
    const offers = await tryListOffers();
    if (offers) {
      const target = offers.filter((o: any) => {
        const stat = String(o?.status || '').toUpperCase();
        const sku = o?.sku;
        const badSku = !validSku(sku);
        return (deleteAllUnpublished && stat === 'UNPUBLISHED') || badSku;
      });
      for (const o of target) { await deleteOffer(o.offerId); }
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, mode: results.mode, summary: { offersScanned: offers.length, offersDeleted: results.deletedOffers.length }, attempts: results.attempts, deletedOffers: results.deletedOffers, errors: results.errors }) };
    }

    // Strategy B: inventory scan fallback
    async function listInventory(offset = 0) {
      const params = new URLSearchParams({ limit: '200', offset: String(offset) });
      const url = `${apiHost}/sell/inventory/v1/inventory_item?${params.toString()}`;
      const r = await fetch(url, { headers });
      const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = { raw: t }; }
      results.attempts.push({ status: r.status, url, body: j });
      if (!r.ok) throw new Error(`inventory list failed ${r.status}`);
      const items = Array.isArray(j?.inventoryItems) ? j.inventoryItems : [];
      return { items, next: j?.href && j?.next ? j.next : null };
    }

    let invOffset = 0; let scanned = 0; const maxScans = 2000;
    while (scanned < maxScans) {
      const page = await listInventory(invOffset);
      const items: any[] = page.items;
      if (!items.length) break;
      for (const it of items) {
        const sku: string = it?.sku;
        scanned++;
        const bad = !validSku(sku);
        if (!bad && !deleteAllUnpublished) continue;
        // try to get offers for this sku
        let offersForSku: any[] = [];
        if (validSku(sku)) {
          const p = new URLSearchParams({ sku, limit: '50' });
          const res = await listOffersAttempt(p);
          if (res.ok) offersForSku = Array.isArray(res.body?.offers) ? res.body.offers : [];
        }
        // delete UNPUBLISHED offers for this sku
        for (const o of offersForSku) {
          if (String(o?.status||'').toUpperCase() === 'UNPUBLISHED') await deleteOffer(o.offerId);
        }
        // optionally delete inventory item
        if (bad) await deleteInventoryItem(sku);
      }
      if (!page.next) break; else invOffset += 200;
    }

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, mode: results.mode, scanned, deletedOffers: results.deletedOffers, deletedInventory: results.deletedInventory, attempts: results.attempts, errors: results.errors }) };
  } catch (e: any) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "clean-broken-drafts error", detail: e?.message || String(e) }) };
  }
};
