import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
	try {
		const rawSku = event.queryStringParameters?.sku?.trim();
		const SKU_OK = (s: string) => /^[A-Za-z0-9]{1,50}$/.test(s || '');
		const sku = rawSku && SKU_OK(rawSku) ? rawSku : undefined;
		const limit = Number(event.queryStringParameters?.limit || 20);
		const status = event.queryStringParameters?.status; // e.g., DRAFT, PUBLISHED or comma-separated
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
			// Build an allow-list of statuses if provided (supports comma-separated)
			const allowStatuses = String(status || '')
				.split(',')
				.map((s) => s.trim().toUpperCase())
				.filter(Boolean);
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
						const st = String(o?.status || '').toUpperCase();
						if (!allowStatuses.length || allowStatuses.includes(st)) agg.push(o);
					}
					if (agg.length >= limit) break;
				}
				if (agg.length >= limit) break;
				pageOffset += pageLimit;
			}
			return { offers: agg.slice(0, limit), attempts };
		}
		const attempts: any[] = [];

		// Support comma-separated statuses by aggregating multiple calls
		const normalizedStatuses = (status || '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);


		// Helper to read offers length safely
		const getOffers = (body: any) => (Array.isArray(body?.offers) ? body.offers : []);

		async function aggregateForStatuses(sts: string[], includeMarketplace: boolean) {
			const agg: any[] = [];
			for (const st of sts) {
				const r = await listOnce(true, includeMarketplace);
				attempts.push(r);
				if (!r.ok) continue;
				const arr = getOffers(r.body);
				for (const o of arr) agg.push(o);
			}
			return agg;
		}

		let res: any;
		let offers: any[] = [];

		if (normalizedStatuses.length > 1) {
			// Try with marketplace first
			offers = await aggregateForStatuses(normalizedStatuses, true);
			if (offers.length === 0) {
				// Try again without marketplace filter
				offers = await aggregateForStatuses(normalizedStatuses, false);
			}
			if (offers.length > 0) {
				const seen = new Set<string>();
				const unique = offers.filter((o) => {
					const id = o?.offerId || o?.offer_id || '';
					if (!id || seen.has(id)) return false;
					seen.add(id);
					return true;
				});
				return {
					statusCode: 200,
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ ok: true, total: unique.length, offers: unique, attempts }),
				};
			}
			// Fall through to single-call strategy if still nothing
		}

		// Single status or none
		if (status) {
			res = await listOnce(true, true);
			attempts.push(res);
		} else {
			res = await listOnce(false, true);
			attempts.push(res);
		}

		// If failure with status present, try without status (some accounts/APIs reject offer_status)
		if (!res.ok && status) {
			res = await listOnce(false, true);
			attempts.push(res);
		}
		// If still bad, try without marketplace_id
		if (!res.ok) {
			res = await listOnce(Boolean(status), false);
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

		// Success path: consider empty results as a trigger to broaden filters
		let body = res.body || {};
		offers = getOffers(body);
		if (offers.length === 0) {
			// 1) If we had a status filter, try dropping it (keep marketplace)
			if (status) {
				const r1 = await listOnce(false, true);
				attempts.push(r1);
				if (r1.ok && getOffers(r1.body).length) {
					body = r1.body;
					offers = getOffers(body);
				}
			}
			// 2) If still empty, drop marketplace, keep status if present
			if (offers.length === 0) {
				const r2 = await listOnce(Boolean(status), false);
				attempts.push(r2);
				if (r2.ok && getOffers(r2.body).length) {
					body = r2.body;
					offers = getOffers(body);
				}
			}
			// 3) If still empty, drop both status and marketplace
			if (offers.length === 0) {
				const r3 = await listOnce(false, false);
				attempts.push(r3);
				if (r3.ok && getOffers(r3.body).length) {
					body = r3.body;
					offers = getOffers(body);
				}
			}
			// 4) Last resort: safe aggregation by inventory
			if (offers.length === 0) {
				const safe = await safeAggregateByInventory();
				return {
					statusCode: 200,
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ ok: true, total: safe.offers.length, offers: safe.offers, attempts }),
				};
			}
		}

		// If we removed the status filter, apply client-side filtering now
		const final = status
			? offers.filter(
					(o: any) => String(o?.status || '').toUpperCase() === String(status).toUpperCase()
				)
			: offers;
		if (String(status || '') && res?.url?.includes('offer_status=')) {
			// Already filtered by server; return upstream shape
			return {
				statusCode: 200,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ok: true, ...body, offers: final, total: final.length }),
			};
		}
		const meta: any = {
			ok: true,
			total: final.length,
			offers: final,
			href: body.href,
			next: body.next,
			prev: body.prev,
			attempts,
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
