import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';
import { getPromotionIntent } from '../../src/lib/promotion-queue.js';

export const handler: Handler = async (event) => {
	// Log immediately to confirm function is invoked
	console.log('[ebay-list-offers] ========================================');
	console.log('[ebay-list-offers] Function invoked at:', new Date().toISOString());
	console.log('[ebay-list-offers] Method:', event.httpMethod);
	console.log('[ebay-list-offers] Path:', event.path);
	console.log('[ebay-list-offers] Query params:', JSON.stringify(event.queryStringParameters));
	
	const startTime = Date.now();
	console.log('[ebay-list-offers] Request started:', { 
		status: event.queryStringParameters?.status,
		limit: event.queryStringParameters?.limit,
		offset: event.queryStringParameters?.offset
	});
	
	// Add global timeout to prevent hanging
	const globalTimeout = setTimeout(() => {
		console.error('[ebay-list-offers] CRITICAL: Function timeout at 25 seconds - aborting');
	}, 25000); // 25 second global timeout (Netlify free tier has 26s limit)
	
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
		if (!bearer || !sub) {
			console.log('[ebay-list-offers] Unauthorized');
			return { 
				statusCode: 401, 
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ error: 'Unauthorized' })
			};
		}
		const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
		const refresh = saved?.refresh_token as string | undefined;
		if (!refresh) {
			console.log('[ebay-list-offers] No eBay refresh token');
			return { 
				statusCode: 400, 
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ error: 'Connect eBay first' }) 
			};
		}
		
		console.log('[ebay-list-offers] Refreshing access token...');
		const { access_token } = await accessTokenFromRefresh(refresh);
		console.log('[ebay-list-offers] Access token refreshed in', Date.now() - startTime, 'ms');
		const { apiHost } = tokenHosts(process.env.EBAY_ENV);
		const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
		const headers = {
			Authorization: `Bearer ${access_token}`,
			Accept: 'application/json',
			'Accept-Language': 'en-US',
			'Content-Language': 'en-US',
			'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
		} as Record<string, string>;

		async function listOnce(includeStatus: boolean, includeMarketplace: boolean, specificStatus?: string) {
			const params = new URLSearchParams();
			if (sku) params.set('sku', sku);
			if (includeStatus && (specificStatus || status)) params.set('offer_status', specificStatus || status!);
			if (includeMarketplace) params.set('marketplace_id', MARKETPLACE_ID);
			params.set('limit', String(limit));
			params.set('offset', String(offset));
			const url = `${apiHost}/sell/inventory/v1/offer?${params.toString()}`;
			
			console.log('[ebay-list-offers] Calling eBay API:', url);
			const callStart = Date.now();
			
			// Add timeout to prevent hanging
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout
			
			try {
				const r = await fetch(url, { 
					headers,
					signal: controller.signal 
				});
				clearTimeout(timeoutId);
				
				const txt = await r.text();
				const callElapsed = Date.now() - callStart;
				console.log('[ebay-list-offers] eBay API responded in', callElapsed, 'ms, status:', r.status);
				
				let json: any;
				try {
					json = JSON.parse(txt);
				} catch {
					json = { raw: txt };
				}
				
				// Log error responses for debugging
				if (!r.ok) {
					const code = Number((json?.errors && json.errors[0]?.errorId) || 0);
					const errorMsg = json?.errors && json.errors[0]?.message;
					console.error('[ebay-list-offers] eBay API error - Status:', r.status, 'Code:', code, 'Message:', errorMsg);
					// Log full response for non-25707 errors
					if (code !== 25707) {
						console.error('[ebay-list-offers] Full error response:', JSON.stringify(json, null, 2));
					}
				}
				
				return { ok: r.ok, status: r.status, url, body: json };
			} catch (err: any) {
				clearTimeout(timeoutId);
				const callElapsed = Date.now() - callStart;
				
				if (err.name === 'AbortError') {
					console.error('[ebay-list-offers] eBay API timeout after', callElapsed, 'ms');
					return { 
						ok: false, 
						status: 504, 
						url, 
						body: { error: 'eBay API timeout', detail: 'Request took longer than 8 seconds' } 
					};
				}
				
				console.error('[ebay-list-offers] eBay API error after', callElapsed, 'ms:', err.message);
				throw err;
			}
		}

		// Safe fallback: enumerate inventory items and fetch offers per valid SKU
		async function safeAggregateByInventory(): Promise<{ offers: any[]; attempts: any[] }> {
			const attempts: any[] = [];
			const agg: any[] = [];
			let pageOffset = 0;
			const pageLimit = Math.min(Math.max(limit, 20), 200);
			const fallbackStart = Date.now();
			// Railway has longer timeout than Netlify - use 25s for Railway, 7s for Netlify
			const isRailway = process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID;
			const HARD_LIMIT_MS = isRailway ? 25000 : 7000;
			console.log(`[ebay-list-offers] safeAggregate starting, timeout=${HARD_LIMIT_MS}ms, isRailway=${!!isRailway}`);
			
			// Build an allow-list of statuses if provided (supports comma-separated)
			const allowStatuses = String(status || '')
				.split(',')
				.map((s) => s.trim().toUpperCase())
				.filter(Boolean);
			console.log(`[ebay-list-offers] safeAggregate filtering for statuses: ${JSON.stringify(allowStatuses)}`);
			
			for (let pages = 0; pages < 10; pages++) {
				// Check timeout before each iteration
				if (Date.now() - fallbackStart > HARD_LIMIT_MS) {
					console.warn(`[ebay-list-offers] Soft timeout at ${HARD_LIMIT_MS}ms — returning partial results (found ${agg.length} offers)`);
					break;
				}
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
				console.log(`[ebay-list-offers] safeAggregate page ${pages}: ${items.length} inventory items`);
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
					// Log what we find for each SKU
					if (arr.length > 0) {
						const statuses = arr.map((o: any) => o?.status).join(', ');
						console.log(`[ebay-list-offers] SKU ${s}: ${arr.length} offers with statuses: ${statuses}`);
					}
					for (const o of arr) {
						const st = String(o?.status || '').toUpperCase();
						if (!allowStatuses.length || allowStatuses.includes(st)) {
							console.log(`[ebay-list-offers] ✓ Found matching offer: SKU=${s}, status=${st}, offerId=${o?.offerId}`);
							agg.push(o);
						}
					}
					if (agg.length >= limit) break;
				}
				if (agg.length >= limit) break;
				pageOffset += pageLimit;
			}
			return { offers: agg.slice(0, limit), attempts };
		}
		const attempts: any[] = [];
		
		// Limit total API calls to prevent timeout
		let totalApiCalls = 0;
		const MAX_API_CALLS = 5; // Prevent runaway API calls

		// Support comma-separated statuses by aggregating multiple calls
		const normalizedStatuses = (status || '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);

		console.log('[ebay-list-offers] Querying for statuses:', normalizedStatuses);

		// Helper to read offers length safely
		const getOffers = (body: any) => (Array.isArray(body?.offers) ? body.offers : []);

		// For multiple statuses, try a single call first and filter client-side
		// This is much faster than multiple API calls
		if (normalizedStatuses.length > 0) {
			console.log('[ebay-list-offers] Trying single call with client-side filtering...');
			
			// Rate limit protection: add small delay if called too frequently
			// This prevents 502 errors when drafts page loads immediately after draft creation
			const now = Date.now();
			const lastCallTime = (global as any).lastEbayListOffersCall || 0;
			const timeSinceLastCall = now - lastCallTime;
			if (timeSinceLastCall < 1000) {
				const delayMs = 1000 - timeSinceLastCall;
				console.log('[ebay-list-offers] Rate limit protection: waiting', delayMs, 'ms');
				await new Promise(resolve => setTimeout(resolve, delayMs));
			}
			(global as any).lastEbayListOffersCall = Date.now();
			
		const r = await listOnce(false, true); // Get all offers, filter client-side
		attempts.push(r);
		
		// Check for SKU 25707 error early - if we hit it, go straight to safe aggregation
		if (!r.ok) {
			const code = Number((r.body?.errors && r.body.errors[0]?.errorId) || 0);
			if (r.status === 400 && code === 25707) {
				console.warn('[ebay-list-offers] ⚠️ Error 25707 detected: Invalid SKU in inventory');
				console.log('[ebay-list-offers] Skipping cleanup (disabled) - using safe aggregation instead');
				
				// DISABLED: Auto-delete was too aggressive and deleted valid listings
				// Just use safe aggregation which fetches offers per-SKU instead
				
				// Now use safe aggregation to return valid offers
				const safe = await safeAggregateByInventory();
				const partial = (Date.now() - startTime) > 6500;
				const note = safe.offers.length ? (partial ? 'safe-aggregate-partial' : 'safe-aggregate') : 'safe-aggregate-empty';
				
				return {
					statusCode: 200,
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						ok: true,
						partial,
						total: safe.offers.length,
						offers: safe.offers,
						attempts: [...attempts, ...safe.attempts],
						note,
					}),
				};
			}
		}
		
		if (r.ok) {
			const allOffers = getOffers(r.body);
			console.log('[ebay-list-offers] Got', allOffers.length, 'total offers');				// Filter client-side for requested statuses
				const allowStatuses = normalizedStatuses.map(s => s.toUpperCase());
				const filtered = allOffers.filter((o: any) => {
					const st = String(o?.status || '').toUpperCase();
					return allowStatuses.includes(st);
				});
				
				console.log('[ebay-list-offers] Filtered to', filtered.length, 'offers matching', allowStatuses);
				
				if (filtered.length > 0) {
					const elapsed = Date.now() - startTime;
					console.log('[ebay-list-offers] Success in', elapsed, 'ms');
					return {
						statusCode: 200,
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ 
							ok: true, 
							total: filtered.length, 
							offers: filtered.slice(0, limit),
							attempts,
							elapsed 
						}),
					};
				}
			}
			
			console.log('[ebay-list-offers] Client-side filtering returned no results, trying individual status queries...');
		}

	async function aggregateForStatuses(sts: string[], includeMarketplace: boolean) {
		const agg: any[] = [];
		const HARD_LIMIT_MS = 7000; // 7 seconds - prevent timeout
		for (const st of sts) {
			// Check timeout before each status query
			if (Date.now() - startTime > HARD_LIMIT_MS) {
				console.warn('[ebay-list-offers] Soft timeout in aggregation — returning partial results');
				break;
			}
			console.log('[ebay-list-offers] Querying status:', st);
			const r = await listOnce(true, includeMarketplace, st);
			attempts.push(r);
				if (!r.ok) continue;
				const arr = getOffers(r.body);
				console.log('[ebay-list-offers] Got', arr.length, 'offers for status:', st);
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
		res = await listOnce(Boolean(status), false, status);
		attempts.push(res);
	}		if (!res.ok) {
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
				headers: { 'Content-Type': 'application/json' },
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
		
		// Enrich offers with inventory item titles and weight for faster frontend display
		// Fetch data in parallel with limited concurrency to avoid timeout
		const enrichWithInventoryData = async (offerList: any[]) => {
			const concurrency = 10;
			const queue = offerList.map((offer, index) => async () => {
				const sku = offer?.sku;
				if (!sku) return;
				
				try {
					const invUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
					const invRes = await fetch(invUrl, { headers });
					if (invRes.ok) {
						const invTxt = await invRes.text();
						const invJson = JSON.parse(invTxt);
						const title = invJson?.product?.title || invJson?.title;
						if (title) {
							offerList[index]._enrichedTitle = title;
						}
						// Include weight info for "needs attention" detection
						const weight = invJson?.packageWeightAndSize?.weight;
						if (weight?.value && weight?.value > 0) {
							offerList[index]._hasWeight = true;
							offerList[index]._weight = { value: weight.value, unit: weight.unit || 'OUNCE' };
						} else {
							offerList[index]._hasWeight = false;
						}
					}
				} catch {
					// Skip on error, title will show as SKU
				}
			});
			
			let i = 0;
			const next = async (): Promise<void> => {
				const fn = queue[i++];
				if (!fn) return;
				await fn();
				return next();
			};
			
			const workers = Array.from({ length: Math.min(concurrency, queue.length) }, next);
			await Promise.all(workers);
		};
		
		// Only enrich if we have a reasonable number of offers (prevent timeout)
		if (final.length > 0 && final.length <= 50) {
			const enrichStart = Date.now();
			await enrichWithInventoryData(final);
			console.log('[ebay-list-offers] Inventory data enrichment took', Date.now() - enrichStart, 'ms');
		}

		// Enrich offers with cached promotion intent from Redis (eBay does not persist merchantData)
		if (final.length > 0) {
			try {
				const intents = await Promise.all(
					final.map(async (offer) => {
						const offerId = offer?.offerId;
						if (!offerId) return null;
						return getPromotionIntent(offerId);
					})
				);

				intents.forEach((intent, idx) => {
					if (!intent || !intent.enabled) return;
					const target = final[idx];
					target.merchantData = target.merchantData || {};
					target.merchantData.autoPromote = true;
					target.merchantData.autoPromoteAdRate = intent.adRate;
				});
			} catch (promoErr) {
				console.warn('[ebay-list-offers] Failed to enrich promotion intent:', promoErr);
			}
		}
		
		// 🔍 DEBUG: Log image URLs in offers for debugging
		console.log('[ebay-list-offers] 🖼️ Image data in offers:');
		for (const offer of final.slice(0, 10)) {
			const offerId = offer?.offerId || 'unknown';
			const sku = offer?.sku || 'unknown';
			const listingPhotos = offer?.listing?.photoUrls || offer?.listing?.imageUrls || [];
			console.log(`[ebay-list-offers]   Offer ${offerId} (SKU: ${sku}):`);
			console.log(`[ebay-list-offers]     listing.photoUrls: ${JSON.stringify(listingPhotos)}`);
		}
		
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
		const elapsed = Date.now() - startTime;
		console.error('[ebay-list-offers] Error after', elapsed, 'ms:', e);
		console.error('[ebay-list-offers] Stack:', e?.stack);
		
		// Return 503 (Service Unavailable) instead of 500 to indicate temporary issue
		return {
			statusCode: 503,
			headers: { 
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ 
				error: 'list-offers temporarily unavailable', 
				detail: e?.message || String(e),
				elapsed,
				retry: true,
				retryAfter: 2 // Suggest retry after 2 seconds (in body instead of header)
			}),
		};
	} finally {
		clearTimeout(globalTimeout);
		const totalElapsed = Date.now() - startTime;
		console.log('[ebay-list-offers] Request completed in', totalElapsed, 'ms');
	}
};