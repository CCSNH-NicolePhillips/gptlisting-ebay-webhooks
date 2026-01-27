import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

type CleanupItem = { sku: string; excludeOfferId?: string };

export const handler: Handler = async (event) => {
	try {
		// Auth check
		const bearer = getBearerToken(event);
		let sub = (await requireAuthVerified(event))?.sub || null;
		if (!sub) sub = getJwtSubUnverified(event);
		if (!bearer || !sub) {
			return {
				statusCode: 401,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ error: 'Unauthorized' }),
			};
		}

		const method = (event.httpMethod || 'GET').toUpperCase();
		let items: CleanupItem[] = [];
		if (method === 'POST' || method === 'PUT') {
			const body = event.body ? JSON.parse(event.body) : {};
			if (Array.isArray(body?.items)) items = body.items as CleanupItem[];
			else if (body?.sku) items = [{ sku: String(body.sku), excludeOfferId: body.excludeOfferId }];
		}
		if (!items.length) {
			const sku = event.queryStringParameters?.sku || '';
			const excludeOfferId = event.queryStringParameters?.excludeOfferId || undefined;
			if (!sku) return { statusCode: 400, body: JSON.stringify({ error: 'missing sku' }) };
			items = [{ sku: String(sku), excludeOfferId }];
		}

		const store = tokensStore();
		const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
		const refresh = saved?.refresh_token as string | undefined;
		if (!refresh) return { statusCode: 400, body: JSON.stringify({ error: 'Connect eBay first' }) };
		const { access_token } = await accessTokenFromRefresh(refresh);
		const { apiHost } = tokenHosts(process.env.EBAY_ENV);
		const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
		const headers = {
			Authorization: `Bearer ${access_token}`,
			Accept: 'application/json',
			'Content-Language': 'en-US',
			'Accept-Language': 'en-US',
			'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
		} as Record<string, string>;

		async function listOffersBySku(sku: string) {
			const url = `${apiHost}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&limit=200`;
			const r = await fetch(url, { headers });
			const txt = await r.text();
			let json: any; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
			if (!r.ok) throw Object.assign(new Error('list offers failed'), { status: r.status, body: json, url });
			return Array.isArray(json.offers) ? json.offers : [];
		}
		async function deleteOffer(offerId: string) {
			const url = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
			const r = await fetch(url, { method: 'DELETE', headers });
			const txt = await r.text();
			let json: any; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
			return { ok: r.ok, status: r.status, body: json, url };
		}

		const results: any[] = [];
		for (const it of items) {
			const sku = String(it.sku || '').trim();
			if (!sku) { results.push({ sku, error: 'empty sku' }); continue; }
			try {
				const offers = await listOffersBySku(sku);
				const toDelete = offers.filter((o: any) => String(o.status).toUpperCase() === 'UNPUBLISHED' && (!it.excludeOfferId || String(o.offerId) !== String(it.excludeOfferId)));
				const deleted: string[] = []; const errors: any[] = [];
				for (const o of toDelete) {
					const del = await deleteOffer(String(o.offerId));
					if (del.ok) deleted.push(String(o.offerId)); else errors.push({ offerId: String(o.offerId), status: del.status, body: del.body });
				}
				results.push({ sku, count: toDelete.length, deleted, errors });
			} catch (e: any) {
				results.push({ sku, error: e?.body || e?.message || String(e) });
			}
		}
		return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, results }) };
	} catch (e: any) {
		return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'clean-drafts error', detail: e?.message || String(e) }) };
	}
};
