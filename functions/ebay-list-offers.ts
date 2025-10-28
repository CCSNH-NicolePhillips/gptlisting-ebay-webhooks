import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from './_common.js';
import { tokensStore } from './_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from './_auth.js';

export const handler: Handler = async (event) => {
  try {
    const rawSku = event.queryStringParameters?.sku?.trim();
    const SKU_OK = (s: string) => /^[A-Za-z0-9]{1,50}$/.test(s || '');
    const sku = rawSku && SKU_OK(rawSku) ? rawSku : undefined;
    const limit = Number(event.queryStringParameters?.limit || 20);
    const status = event.queryStringParameters?.status; // e.g., DRAFT, PUBLISHED
    const offset = Number(event.queryStringParameters?.offset || 0);
  const store = tokensStore();
  const bearer = getBearerToken(event);
  let sub = (await requireAuthVerified(event))?.sub || null;
  if (!sub) sub = getJwtSubUnverified(event);
  if (!bearer || !sub) return { statusCode: 401, body: 'Unauthorized' };
  const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) return { statusCode: 400, body: JSON.stringify({ error: 'Connect eBay first' }) };
    const { access_token } = await accessTokenFromRefresh(refresh);
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
    const headers = {
      Authorization: `Bearer ${access_token}`,
      Accept: 'application/json',
      'Accept-Language': 'en-US',
      'Content-Language': 'en-US',
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
    } as Record<string, string>;

    async function listOnce(includeStatus: boolean, includeMarketplace: boolean) {
      const params = new URLSearchParams();
      if (sku) params.set('sku', sku);
      if (includeStatus && status) params.set('offer_status', status);
      if (includeMarketplace) params.set('marketplace_id', MARKETPLACE_ID);
      params.set('limit', String(limit));
      params.set('offset', String(offset));
      const url = `${apiHost}/sell/inventory/v1/offer?${params.toString()}`;
      const r = await fetch(url, { headers });
      const txt = await r.text();
      let json: any;
      try {
        json = JSON.parse(txt);
      } catch {
        json = { raw: txt };
      }
      return { ok: r.ok, status: r.status, url, body: json };
    }

    // Safe fallback: enumerate inventory items and fetch offers per valid SKU
    async function safeAggregateByInventory(): Promise<{ offers: any[]; attempts: any[] }> {
      const attempts: any[] = [];
      const agg: any[] = [];
      let pageOffset = 0;
      const pageLimit = Math.min(Math.max(limit, 20), 200);
      for (let pages = 0; pages < 10; pages++) {
        // cap pages to avoid runaway
        const invParams = new URLSearchParams({
          limit: String(pageLimit),
          offset: String(pageOffset),
        });
        const invUrl = `${apiHost}/sell/inventory/v1/inventory_item?${invParams.toString()}`;
        const invRes = await fetch(invUrl, { headers });
        const invTxt = await invRes.text();
        let invJson: any;
        try {
          invJson = JSON.parse(invTxt);
        } catch {
          invJson = { raw: invTxt };
        }
        attempts.push({ url: invUrl, status: invRes.status, body: invJson });
        if (!invRes.ok) break;
        const items = Array.isArray(invJson?.inventoryItems) ? invJson.inventoryItems : [];
        if (!items.length) break;
        for (const it of items) {
          const s = it?.sku as string | undefined;
          if (!SKU_OK(s || '')) continue; // skip invalid sku to avoid 400
          const p = new URLSearchParams({ sku: s!, limit: '50' });
          const url = `${apiHost}/sell/inventory/v1/offer?${p.toString()}`;
          const r = await fetch(url, { headers });
          const t = await r.text();
          let j: any;
          try {
            j = JSON.parse(t);
          } catch {
            j = { raw: t };
          }
          attempts.push({ url, status: r.status, body: j });
          if (!r.ok) continue;
          const arr = Array.isArray(j?.offers) ? j.offers : [];
          for (const o of arr) {
            if (!status || String(o?.status || '').toUpperCase() === String(status).toUpperCase())
              agg.push(o);
          }
          if (agg.length >= limit) break;
        }
        if (agg.length >= limit) break;
        pageOffset += pageLimit;
      }
      return { offers: agg.slice(0, limit), attempts };
    }
    const attempts: any[] = [];

    // 1) Try with status + marketplace
    let res = await listOnce(true, true);
    attempts.push(res);
    // If failure with status present, try without status (some accounts/APIs reject offer_status)
    if (!res.ok && status) {
      res = await listOnce(false, true);
      attempts.push(res);
    }
    // If still bad (e.g., 400 invalid SKU spurious), try without marketplace_id
    if (!res.ok) {
      res = await listOnce(false, false);
      attempts.push(res);
    }

    if (!res.ok) {
      // If we hit the SKU 25707 issue, attempt safe aggregation
      const code = Number((res.body?.errors && res.body.errors[0]?.errorId) || 0);
      if (res.status === 400 && code === 25707) {
        const safe = await safeAggregateByInventory();
        const note = safe.offers.length ? 'safe-aggregate' : 'safe-aggregate-empty';
        const warning = safe.offers.length
          ? undefined
          : 'Upstream offer listing failed due to invalid SKU values. Showing filtered results.';
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ok: true,
            total: safe.offers.length,
            offers: safe.offers,
            attempts: [...attempts, ...safe.attempts],
            note,
            warning,
          }),
        };
      }
      return {
        statusCode: res.status,
        body: JSON.stringify({ error: 'list-offers failed', attempt: attempts }),
      };
    }

    // Success path
    const body = res.body || {};
    const offers = Array.isArray(body.offers) ? body.offers : [];
    // If we removed the status filter, apply client-side filtering now
    const final = status
      ? offers.filter(
          (o: any) => String(o?.status || '').toUpperCase() === String(status).toUpperCase()
        )
      : offers;
    if (res.url.includes('offer_status=') && body.offers) {
      // Already filtered by server; return upstream shape
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, ...body }),
      };
    }
    const meta: any = {
      ok: true,
      total: final.length,
      offers: final,
      href: body.href,
      next: body.next,
      prev: body.prev,
    };
    if (rawSku && !sku) meta.note = 'sku filter ignored due to invalid characters';
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meta),
    };
  } catch (e: any) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'list-offers error', detail: e?.message || String(e) }),
    };
  }
};
