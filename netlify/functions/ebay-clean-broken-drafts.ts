import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

type J = Record<string, any>;

export const handler: Handler = async (event) => {
	const startTime = Date.now();
	const MAX_EXECUTION_TIME = 20000; // 20 seconds (leave buffer before Netlify timeout)
	
	try {
		const qp = event.queryStringParameters || ({} as any);
		const dryRun = /^1|true|yes$/i.test(String(qp.dryRun || qp.dry || 'false'));
		const deleteAllUnpublished = /^1|true|yes$/i.test(String(qp.deleteAll || qp.all || 'false'));
		const deleteInventory = /^1|true|yes$/i.test(String(qp.deleteInventory || qp.inv || 'false'));

		// Check for admin token bypass
		const isAdminAuth = qp.adminToken && qp.adminToken === process.env.ADMIN_API_TOKEN;
		
		// Get user-scoped eBay token
		const store = tokensStore();
		let sub: string | null = null;
		let refresh: string | undefined;

		if (isAdminAuth) {
			// Admin mode: use userSub parameter to specify which user's token
			const targetUserSub = qp.userSub;
			if (!targetUserSub) {
				return { statusCode: 400, body: JSON.stringify({ error: 'Admin mode requires userSub parameter' }) };
			}
			const saved = (await store.get(userScopedKey(targetUserSub, 'ebay.json'), { type: 'json' })) as J | null;
			refresh = saved?.refresh_token as string | undefined;
			if (!refresh) {
				return { statusCode: 400, body: JSON.stringify({ error: `No eBay token found for user ${targetUserSub}` }) };
			}
			sub = targetUserSub;
		} else {
			// Normal user auth mode
			const bearer = getBearerToken(event);
			sub = (await requireAuthVerified(event))?.sub || null;
			if (!sub) sub = getJwtSubUnverified(event);
			if (!bearer || !sub) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
			
			const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as J | null;
			refresh = saved?.refresh_token as string | undefined;
			if (!refresh) return { statusCode: 400, body: JSON.stringify({ error: 'Connect eBay first' }) };
		}
		
		const { access_token } = await accessTokenFromRefresh(refresh);

		const ENV = process.env.EBAY_ENV || 'PROD';
		const { apiHost } = tokenHosts(ENV);
		const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
		const headers = {
			Authorization: `Bearer ${access_token}`,
			Accept: 'application/json',
			'Content-Language': 'en-US',
			'Accept-Language': 'en-US',
			'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
			'Content-Type': 'application/json',
		} as Record<string, string>;

		const results = {
			mode: { dryRun, deleteAllUnpublished, deleteInventory },
			deletedOffers: [] as any[],
			deletedInventory: [] as any[],
			errors: [] as any[],
			attempts: [] as any[],
		};

		const validSku = (s?: string) => !!s && /^[A-Za-z0-9]{1,50}$/.test(s);

		async function listInventory(offset = 0) {
			const params = new URLSearchParams({ limit: '200', offset: String(offset) });
			const url = `${apiHost}/sell/inventory/v1/inventory_item?${params.toString()}`;
			const r = await fetch(url, { headers });
			const t = await r.text();
			let j: any;
			try {
				j = JSON.parse(t);
			} catch {
				j = { raw: t };
			}
			results.attempts.push({ status: r.status, url, body: j });
			if (!r.ok) throw new Error(`inventory list failed ${r.status}`);
			const items = Array.isArray(j?.inventoryItems) ? j.inventoryItems : [];
			return { items, next: j?.href && j?.next ? j.next : null };
		}

		async function deleteOffer(offerId: string) {
			const url = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
			if (dryRun) {
				results.deletedOffers.push({ offerId, dryRun: true });
				return true;
			}
			const r = await fetch(url, { method: 'DELETE', headers });
			if (r.ok) {
				results.deletedOffers.push({ offerId });
				return true;
			}
			const t = await r.text();
			let j: any;
			try {
				j = JSON.parse(t);
			} catch {
				j = { raw: t };
			}
			results.errors.push({ action: 'delete-offer', offerId, url, status: r.status, body: j });
			return false;
		}

		async function deleteInventoryItem(sku: string) {
			const url = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
			if (!deleteInventory) return false;
			if (dryRun) {
				results.deletedInventory.push({ sku, dryRun: true });
				return true;
			}
			const r = await fetch(url, { method: 'DELETE', headers });
			if (r.ok) {
				results.deletedInventory.push({ sku });
				return true;
			}
			const t = await r.text();
			let j: any;
			try {
				j = JSON.parse(t);
			} catch {
				j = { raw: t };
			}
			results.errors.push({ action: 'delete-inventory', sku, url, status: r.status, body: j });
			return false;
		}

		async function listOffersForSku(sku: string): Promise<any[]> {
			if (!validSku(sku)) return [];
			const params = new URLSearchParams({ sku, limit: '50' });
			const url = `${apiHost}/sell/inventory/v1/offer?${params.toString()}`;
			const r = await fetch(url, { headers });
			if (!r.ok) return [];
			const t = await r.text();
			let j: any;
			try {
				j = JSON.parse(t);
			} catch {
				return [];
			}
			results.attempts.push({ status: r.status, url, body: j });
			return Array.isArray(j?.offers) ? j.offers : [];
		}

		// Strategy: Scan inventory items directly (offers listing is broken by invalid SKUs)
		console.log('[clean-broken-drafts] Using inventory scan strategy (offers listing broken by error 25707)');
		
		let invOffset = 0;
		let scanned = 0;
		const maxScans = 2000;
		let timedOut = false;
		const INTERNAL_LIMIT = 8000; // 8-second upper bound to avoid Netlify hard timeout
		
		while (scanned < maxScans) {
			// Check timeout (internal 8s limit to prevent hard 502)
			if (Date.now() - startTime > INTERNAL_LIMIT) {
				console.log(`[clean-broken-drafts] Internal timeout at ${scanned} items scanned (8s limit)`);
				timedOut = true;
				break;
			}
			
			const page = await listInventory(invOffset);
			const items: any[] = page.items;
			if (!items.length) break;
			
			for (const it of items) {
				const sku: string = it?.sku;
				scanned++;
				const bad = !validSku(sku);
				
				// Get offers for this SKU (if valid)
				const offersForSku = await listOffersForSku(sku);
				
				// Delete UNPUBLISHED offers (or all if deleteAllUnpublished flag set)
				for (const o of offersForSku) {
					const status = String(o?.status || '').toUpperCase();
					if (deleteAllUnpublished && status === 'UNPUBLISHED') {
						await deleteOffer(o.offerId);
					} else if (bad) {
						// Delete any offer for bad SKU
						await deleteOffer(o.offerId);
					}
				}
				
				// Delete inventory item if SKU is invalid
				if (bad && deleteInventory) {
					await deleteInventoryItem(sku);
				}
			}
			
			if (!page.next) break;
			else invOffset += 200;
		}

		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				ok: true,
				mode: results.mode,
				scanned,
				timedOut,
				deletedOffers: results.deletedOffers,
				deletedInventory: results.deletedInventory,
				attempts: results.attempts,
				errors: results.errors,
				message: timedOut ? 'Partial deletion - run again to continue' : 'Completed'
			}),
		};
	} catch (e: any) {
		console.error('[ebay-clean-broken-drafts] Error:', e);
		console.error('[ebay-clean-broken-drafts] Stack:', e?.stack);
		return {
			statusCode: 500,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ 
				error: 'clean-broken-drafts error', 
				detail: e?.message || String(e),
				stack: process.env.NODE_ENV === 'development' ? e?.stack : undefined
			}),
		};
	}
};
