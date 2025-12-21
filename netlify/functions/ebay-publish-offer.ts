import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';
import { queuePromotionJob } from '../../src/lib/promotion-queue.js';

export const handler: Handler = async (event) => {
	try {
		const body = event.body ? JSON.parse(event.body) : {};
		const offerId = event.queryStringParameters?.offerId || body.offerId;
		const conditionRaw = event.queryStringParameters?.condition ?? body.condition; // optional numeric
		if (!offerId) return { statusCode: 400, body: JSON.stringify({ error: 'missing offerId' }) };
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
			'Content-Language': 'en-US',
			'Accept-Language': 'en-US',
			'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
			'Content-Type': 'application/json',
		} as Record<string, string>;

		async function publishOnce() {
			const url = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`;
			const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({}) });
			const txt = await r.text();
			let json: any;
			try {
				json = JSON.parse(txt);
			} catch {
				json = { raw: txt };
			}
			return { ok: r.ok, status: r.status, body: json, url };
		}

		let pub = await publishOnce();
		// If publish fails, inspect common fixable errors
		const errors = ([] as any[]).concat(pub.body?.errors || pub.body || []);
		// 25020: Missing/invalid package weight — set a default weight on the inventory item and retry
		const needsWeightFix = !pub.ok && errors.some((e) => Number(e?.errorId) === 25020);
		if (needsWeightFix) {
			// Fetch current offer to get SKU
			const getOfferUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
			const getOfferRes = await fetch(getOfferUrl, { headers });
			const getOfferTxt = await getOfferRes.text();
			let off: any = {};
			try { off = JSON.parse(getOfferTxt); } catch { off = {}; }
			const sku = (off && (off.sku || off?.offer?.sku)) ? String(off.sku || off.offer?.sku) : '';
			if (getOfferRes.ok && sku) {
				// Fetch inventory item, add a reasonable default weight if missing/zero, then PUT back
				const getInvUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
				const invRes = await fetch(getInvUrl, { headers });
				const invTxt = await invRes.text();
				let inv: any = {};
				try { inv = JSON.parse(invTxt); } catch { inv = {}; }
				if (invRes.ok) {
					const existingW = inv?.packageWeightAndSize?.weight?.value;
					const unit = (inv?.packageWeightAndSize?.weight?.unit || 'OUNCE').toString().toUpperCase();
					const current = Number(existingW || 0);
					// Default to 16 oz (1 lb) when absent or invalid
					const newWeight = Number.isFinite(current) && current > 0 ? current : 16;
					const patched: any = {
						sku,
						product: inv?.product,
						availability: inv?.availability,
						condition: inv?.condition,
						packageWeightAndSize: {
							...(inv?.packageWeightAndSize || {}),
							weight: { value: Math.round(newWeight * 10) / 10, unit: unit || 'OUNCE' },
						},
					};
					const putInvUrl = getInvUrl;
					const putInvRes = await fetch(putInvUrl, {
						method: 'PUT',
						headers,
						body: JSON.stringify(patched),
					});
					// Even if update fails, proceed to return the original publish error; else retry publish once
					if (putInvRes.ok) {
						pub = await publishOnce();
					}
				}
			}
		}

		// If publish fails due to invalid/missing condition (25021), attempt to update offer with numeric condition and retry once
		const needsCondFix = !pub.ok && errors.some((e) => Number(e?.errorId) === 25021);
		if (needsCondFix) {
			// Fetch current offer
			const getUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
			const getRes = await fetch(getUrl, { headers });
			const getTxt = await getRes.text();
			let offer: any;
			try {
				offer = JSON.parse(getTxt);
			} catch {
				offer = {};
			}
			if (!getRes.ok) {
				return {
					statusCode: pub.status,
					body: JSON.stringify({
						error: 'publish failed',
						status: pub.status,
						detail: pub.body,
						note: 'also failed to fetch offer to auto-fix condition',
						getUrl,
						getRes: offer,
					}),
				};
			}
			const condNum = Number(conditionRaw ?? offer?.condition ?? 1000);
			const updatePayload: any = {
				sku: offer?.sku,
				marketplaceId: offer?.marketplaceId,
				format: offer?.format || 'FIXED_PRICE',
				availableQuantity: offer?.availableQuantity,
				categoryId: offer?.categoryId,
				listingDescription: offer?.listingDescription,
				pricingSummary: offer?.pricingSummary,
				listingPolicies: offer?.listingPolicies,
				merchantLocationKey: offer?.merchantLocationKey,
				condition: Number.isFinite(condNum) ? condNum : 1000,
			};
			const putUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
			const putRes = await fetch(putUrl, {
				method: 'PUT',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify(updatePayload),
			});
			const putTxt = await putRes.text();
			let putJson: any;
			try {
				putJson = JSON.parse(putTxt);
			} catch {
				putJson = { raw: putTxt };
			}
			if (!putRes.ok) {
				return {
					statusCode: pub.status,
					body: JSON.stringify({
						error: 'publish failed',
						status: pub.status,
						detail: pub.body,
						note: 'failed to update offer condition before retry',
						update: { url: putUrl, status: putRes.status, body: putJson },
					}),
				};
			}
			// retry publish once
			pub = await publishOnce();
		}
	if (!pub.ok) {
			// Do NOT auto-delete. Return a clear error payload so the UI can show details and the user can fix or delete manually.
			return {
				statusCode: pub.status,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					ok: false,
					error: 'publish failed',
					publish: { url: pub.url, status: pub.status, detail: pub.body },
				}),
			};
		}
		// Success: record that this offer was published so we can hide it from future 'drafts' after it is ended/unlisted.
		try {
	const store2 = tokensStore();
	const key = userScopedKey(sub!, 'published.json');
	const cur = ((await store2.get(key, { type: 'json' })) as any) || {};
			const stamp = new Date().toISOString();
			// Try to capture SKU from offer body if present
	let sku: string | undefined = undefined;
	try { sku = pub.body?.sku ? String(pub.body.sku) : undefined; } catch {}
			cur[String(offerId)] = { offerId: String(offerId), sku, publishedAt: stamp };
	await store2.set(key, JSON.stringify(cur));
		} catch {
			// ignore persistence errors
		}

		// Step 3: Check for auto-promotion after successful publish
		// Load user's promotion settings from policy defaults (not from eBay's non-existent merchantData)
		let promotionResult: any = null;
		try {
			const policyDefaultsKey = userScopedKey(sub!, 'policy-defaults.json');
			let policyDefaults: any = {};
			try {
				policyDefaults = (await store.get(policyDefaultsKey, { type: 'json' })) || {};
			} catch {
				// No policy defaults saved, promotions disabled
			}
			
			// Check if user has auto-promote enabled in their settings
			const autoPromote = policyDefaults.autoPromote === true;
			const defaultAdRate = typeof policyDefaults.defaultAdRate === 'number' ? policyDefaults.defaultAdRate : 5;
			
			// Fetch the offer to get SKU and listingId
			const getOfferUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
			const getOfferRes = await fetch(getOfferUrl, { headers });
			
			if (getOfferRes.ok && autoPromote) {
				const offerText = await getOfferRes.text();
				const offer = JSON.parse(offerText);
				const offerSku = typeof offer?.sku === 'string'
					? offer.sku
					: typeof offer?.offer?.sku === 'string'
						? offer.offer.sku
						: undefined;
				
				console.log(`[ebay-publish-offer] Auto-promotion enabled for user, SKU ${offerSku}, offerId ${offerId}`);
				console.log(`[ebay-publish-offer] Using ad rate from policy defaults: ${defaultAdRate}%`);
				
				const adRate = defaultAdRate;
				
				// Get listingId from publish response
				const listingId = pub.body?.listingId || offer.listing?.listingId;
				
				if (listingId) {
					// Queue promotion job for background processing
					try {
						const jobId = await queuePromotionJob(sub!, listingId, adRate, {
							sku: offerSku,
						});
						
						console.log(`[ebay-publish-offer] Queued promotion job ${jobId} for listing ${listingId}`);
						
						promotionResult = {
							queued: true,
							listingId: listingId,
							jobId: jobId,
							adRate: adRate,
							message: 'Promotion queued for background processing',
						};
					} catch (promoErr: any) {
						console.error(`[ebay-publish-offer] Failed to queue promotion for listing ${listingId}:`, {
							error: promoErr.message,
							listingId: listingId,
							offerId: offerId,
						});
						
						promotionResult = {
							queued: false,
							listingId: listingId,
							error: promoErr.message,
							reason: 'Failed to queue promotion job',
						};
					}
				} else {
					console.warn(`[ebay-publish-offer] Cannot queue promotion - listingId not found in response`);
					promotionResult = {
						queued: false,
						error: 'listingId not available',
						reason: 'Listing ID not found in eBay publish response',
					};
				}
			} else if (!getOfferRes.ok) {
				console.log(`[ebay-publish-offer] Could not fetch offer details for offerId ${offerId}`);
			} else if (!autoPromote) {
				console.log(`[ebay-publish-offer] Auto-promotion not enabled for user, skipping for offerId ${offerId}`);
			}
		} catch (err: any) {
			// Log error but don't fail the publish
			console.error(`[ebay-publish-offer] Error checking auto-promotion:`, err.message);
		}

		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ 
				ok: true, 
				result: pub.body,
				promotion: promotionResult, // Include promotion result in response
			}),
		};
	} catch (e: any) {
		return {
			statusCode: 500,
			body: JSON.stringify({ error: 'publish-offer error', detail: e?.message || String(e) }),
		};
	}
};
