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
	const skipFastScan = /^1|true|yes$/i.test(String(qp.skipFastScan || 'false'));
	const nuclearMode = /^1|true|yes$/i.test(String(qp.nuclear || 'false')); // FAST: Just delete inventory, no offer checking
	const deleteOrphans = /^1|true|yes$/i.test(String(qp.orphans || 'false')); // Delete inventory items with no offers
	
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

		async function deleteInventoryItem(sku: string, forceAllowDeletion = false) {
			const url = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
			if (!deleteInventory && !forceAllowDeletion) return false;
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
		
		async function listAllOffersDirect(offset = 0): Promise<{ offers: any[]; next: string | null }> {
			// Direct offers listing - faster than scanning inventory
			const params = new URLSearchParams({ limit: '100', offset: String(offset) });
			const url = `${apiHost}/sell/inventory/v1/offer?${params.toString()}`;
			const r = await fetch(url, { headers });
			if (!r.ok) {
				const t = await r.text();
				let j: any;
				try { j = JSON.parse(t); } catch { j = { raw: t }; }
			results.attempts.push({ status: r.status, url, body: j });
			// Error 25707 means invalid SKU in listing - throw to trigger fast scan
			if (r.status === 400 && j?.errors?.[0]?.errorId === 25707) {
				console.warn('[clean-broken-drafts] Invalid SKU in offers list (25707), stopping direct listing');
				throw new Error('Error 25707: Invalid SKU in offers');
			}
			throw new Error(`offers list failed ${r.status}`);
			}
			const t = await r.text();
			let j: any;
			try { j = JSON.parse(t); } catch { j = { raw: t }; }
			results.attempts.push({ status: r.status, url, body: j });
			const offers = Array.isArray(j?.offers) ? j.offers : [];
			return { offers, next: j?.href && j?.next ? j.next : null };
		}

	// Declare timeout vars BEFORE fast path to avoid TDZ errors
	let timedOut = false;
	const INTERNAL_LIMIT = 20000; // 20-second upper bound to avoid Netlify hard timeout
	
	// NUCLEAR MODE: Just delete all inventory items directly (fastest, no offer checking)
	if (nuclearMode && deleteInventory) {
		console.log('[clean-broken-drafts] NUCLEAR MODE: Deleting all inventory items directly (no offer checks)');
		let invOffset = 0;
		let scanned = 0;
		
		while (scanned < 2000) {
			if (Date.now() - startTime > INTERNAL_LIMIT) {
				console.log(`[clean-broken-drafts] Nuclear mode timeout at ${scanned} items (20s limit)`);
				timedOut = true;
				break;
			}
			
			const page = await listInventory(invOffset);
			const items = page.items;
			if (!items.length) break;
			
			console.log(`[clean-broken-drafts] Nuclear batch: offset=${invOffset}, count=${items.length}`);
			
			for (const it of items) {
				const sku = it?.sku;
				if (!sku) continue;
				
				scanned++;
				try {
					await deleteInventoryItem(sku);
					results.deletedInventory.push({ sku });
				} catch (err) {
					results.errors.push({ sku, error: String(err) });
				}
			}
			
			if (!page.next) break;
			invOffset += 200;
		}
		
		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				ok: true,
				mode: { ...results.mode, nuclear: true },
				nuclearMode: true,
				scanned,
				timedOut,
				deletedInventory: results.deletedInventory,
				errors: results.errors,
				message: timedOut ? 'Partial deletion - run again' : `Deleted ${results.deletedInventory.length} items`
			}),
		};
	}
	
	// ORPHAN MODE: Delete inventory items that have NO offers (orphaned from old tests)
	// With force=true, skip checking offers and delete all inventory items directly
	if (deleteOrphans) {
		const forceDelete = /^1|true|yes$/i.test(String(qp.force || 'false'));
		console.log(`[clean-broken-drafts] ORPHAN MODE: ${forceDelete ? 'FORCE deleting ALL inventory items' : 'Deleting inventory items with no offers'}`);
		let invOffset = 0;
		let scanned = 0;
		let orphansDeleted = 0;
		let orphansFound: string[] = [];
		
		while (scanned < 2000) {
			if (Date.now() - startTime > INTERNAL_LIMIT) {
				console.log(`[clean-broken-drafts] Orphan mode timeout at ${scanned} items (20s limit)`);
				timedOut = true;
				break;
			}
			
			const page = await listInventory(invOffset);
			const items = page.items;
			if (!items.length) break;
			
			console.log(`[clean-broken-drafts] Orphan scan batch: offset=${invOffset}, count=${items.length}`);
			
			for (const it of items) {
				const sku = it?.sku;
				if (!sku) continue;
				scanned++;
				
				let isOrphan = forceDelete; // If force=true, treat all as orphans
				
				// Only check offers if not forcing
				if (!forceDelete) {
					const offers = await listOffersForSku(sku);
					isOrphan = offers.length === 0;
				}
				
				if (isOrphan) {
					// Orphaned inventory item - no offers (or force delete)
					orphansFound.push(sku);
					console.log(`[clean-broken-drafts] 🗑️ ${forceDelete ? 'Force delete' : 'Orphan'}: ${sku} (${it.product?.title?.slice(0, 40) || 'no title'}...)`);
					
					if (!dryRun) {
						await deleteInventoryItem(sku, true); // forceAllowDeletion=true for orphan mode
						orphansDeleted++;
					}
				}
			}
			
			if (!page.next) break;
			invOffset += 200;
		}
		
		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				ok: true,
				mode: { ...results.mode, orphans: true, dryRun },
				scanned,
				orphansFound: orphansFound.length,
				orphansDeleted: dryRun ? 0 : orphansDeleted,
				orphanSkus: orphansFound.slice(0, 50), // First 50 for reference
				timedOut,
				deletedInventory: results.deletedInventory,
				errors: results.errors,
				message: dryRun 
					? `Found ${orphansFound.length} orphaned inventory items (dry run - nothing deleted)`
					: (timedOut ? 'Partial deletion - run again' : `Deleted ${orphansDeleted} orphaned items`)
			}),
		};
	}
	
	// FAST PATH: If deleteAllUnpublished=true, use direct offer listing (much faster)
	if (deleteAllUnpublished) {
		console.log('[clean-broken-drafts] Fast path: Deleting all unpublished offers via direct listing');
		let offerOffset = 0;
		let totalDeleted = 0;
		const maxOffers = 1000;
		let hit25707 = false;
		
		while (totalDeleted < maxOffers) {
			// Check timeout
			if (Date.now() - startTime > INTERNAL_LIMIT) {
				console.log(`[clean-broken-drafts] Internal timeout at ${totalDeleted} offers deleted (20s limit)`);
				timedOut = true;
				break;
			}
			
			try {
				const page = await listAllOffersDirect(offerOffset);
				const offers = page.offers;
				if (!offers.length) break;
				
				for (const o of offers) {
					const status = String(o?.status || '').toUpperCase();
					if (status === 'UNPUBLISHED') {
						await deleteOffer(o.offerId);
						totalDeleted++;
					}
				}
				
				if (!page.next) break;
				else offerOffset += 100;
			} catch (err) {
				console.error('[clean-broken-drafts] Direct offer listing failed:', err);
				// Check if it's a 25707 error (invalid SKU)
				const errMsg = String(err);
				if (errMsg.includes('25707')) {
					hit25707 = true;
				}
				// Fall back to inventory scan on error
				break;
			}
		}
		
	// If we hit 25707, we MUST scan inventory to find and delete invalid SKUs
	if (hit25707 && !skipFastScan) {
		console.log('[clean-broken-drafts] 25707 detected - FAST SCAN for invalid SKUs only');
		// FAST SCAN: Just find and delete invalid SKUs (no offer processing)
		let fastScanOffset = 0;
		let fastScanned = 0;
		let foundInvalidSku = false;
		while (fastScanned < 1000 && Date.now() - startTime < INTERNAL_LIMIT) {
			const page = await listInventory(fastScanOffset);
			const items = page.items;
			if (!items.length) break;
			
		for (const it of items) {
			const sku = it?.sku;
			fastScanned++;
			const bad = !validSku(sku);
			if (bad) {
				foundInvalidSku = true;
				console.log(`🚫 FAST SCAN found invalid SKU: ${sku}`);
					// Get and delete offers
					const badOffers = await listOffersForSku(sku);
					for (const o of badOffers) {
						await deleteOffer(o.offerId);
					}
					// Delete inventory
					if (deleteInventory) {
						await deleteInventoryItem(sku);
						console.log(`✅ FAST SCAN deleted invalid SKU: ${sku}`);
					}
				}
			}
			
			if (!page.next) break;
			fastScanOffset += 200;
		}
		console.log(`[clean-broken-drafts] Fast scan complete: ${fastScanned} items scanned, foundInvalid=${foundInvalidSku}`);
		
		// If we found invalid SKUs, return and let user retry
		if (foundInvalidSku) {
			return {
				statusCode: 200,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					ok: true,
					mode: results.mode,
					invalidSkuCleanup: true,
					scanned: fastScanned,
					deletedOffers: results.deletedOffers,
					deletedInventory: results.deletedInventory,
					message: 'Deleted invalid SKUs - click Delete All again to continue'
				}),
			};
		}
		
		// No invalid SKUs found - 25707 is a false positive or eBay cache issue
		// Fall through to inventory-based deletion below
		console.log('[clean-broken-drafts] No invalid SKUs found - using inventory-based deletion (offers API broken)');
	} else if (totalDeleted > 0) {
			// Fast path succeeded without errors
			return {
				statusCode: 200,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					ok: true,
					mode: results.mode,
					fastPath: true,
					scanned: totalDeleted,
					timedOut,
					deletedOffers: results.deletedOffers,
					deletedInventory: results.deletedInventory,
					attempts: results.attempts,
					errors: results.errors,
					message: timedOut ? 'Partial deletion - run again to continue' : 'Completed'
				}),
			};
		}
	}		// Strategy: Scan inventory items directly (offers listing is broken by invalid SKUs)
		console.log('[clean-broken-drafts] Using inventory scan strategy (offers listing broken by error 25707)');
		
		let invOffset = 0;
		let scanned = 0;
		const maxScans = 2000;
		
		while (scanned < maxScans) {
			// Check timeout (internal 20s limit to prevent hard 502)
			if (Date.now() - startTime > INTERNAL_LIMIT) {
				console.log(`[clean-broken-drafts] Internal timeout at ${scanned} items scanned (20s limit)`);
				timedOut = true;
				break;
			}
			
		const page = await listInventory(invOffset);
		const items: any[] = page.items;
		if (!items.length) break;
		
		console.log(`[clean-broken-drafts] Processing batch: offset=${invOffset}, count=${items.length}, total scanned so far=${scanned}`);		for (const it of items) {
			const sku: string = it?.sku;
			scanned++;
			const bad = !validSku(sku);
			
			if (bad) {
				console.log(`🚫 Found invalid SKU: ${sku}`);
				// Delete invalid SKU immediately (with its offers)
				const badOffers = await listOffersForSku(sku);
				for (const o of badOffers) {
					await deleteOffer(o.offerId);
				}
				if (deleteInventory) {
					await deleteInventoryItem(sku);
					console.log(`✅ Deleted invalid SKU: ${sku}`);
				}
				continue; // Skip to next item
			}
			
			// Only process valid SKUs if deleteAllUnpublished is true
			if (!deleteAllUnpublished) continue;
			
			// Get offers for this SKU
			const offersForSku = await listOffersForSku(sku);
			
			// Delete UNPUBLISHED offers
			let hasUnpublishedOffer = false;
			for (const o of offersForSku) {
				const status = String(o?.status || '').toUpperCase();
				if (status === 'UNPUBLISHED') {
					await deleteOffer(o.offerId);
					hasUnpublishedOffer = true;
				}
			}
			
			// Delete inventory item if we deleted an unpublished offer
			if (deleteInventory && hasUnpublishedOffer) {
				await deleteInventoryItem(sku);
			}
		}			if (!page.next) break;
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
				skipFastScan: true, // Tell client to skip fast scan on next retry
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
