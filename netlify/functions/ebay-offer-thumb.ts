import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
	try {
		const offerId = event.queryStringParameters?.offerId || event.queryStringParameters?.id;
		if (!offerId) {
			console.warn('[offer-thumb] Missing offerId');
			return { statusCode: 400, body: 'Missing offerId' };
		}

		console.log(`[offer-thumb] Fetching thumbnail for offer: ${offerId}`);

		const store = tokensStore();
		const bearer = getBearerToken(event);
		let sub = (await requireAuthVerified(event))?.sub || null;
		if (!sub) sub = getJwtSubUnverified(event);
		if (!bearer || !sub) {
			console.warn(`[offer-thumb] Unauthorized request for offer ${offerId}`);
			return { statusCode: 401, body: 'Unauthorized' };
		}
		const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
		const refresh = saved?.refresh_token as string | undefined;
		if (!refresh) {
			console.warn(`[offer-thumb] No refresh token for offer ${offerId}`);
			return { statusCode: 401, body: 'Connect eBay first' };
		}
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

		// Helper: fetch with timeout to prevent 502s
		const fetchWithTimeout = async (url: string, options: any, timeoutMs = 8000) => {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const response = await fetch(url, { ...options, signal: controller.signal });
				clearTimeout(timeout);
				return response;
			} catch (e: any) {
				clearTimeout(timeout);
				if (e?.name === 'AbortError') throw new Error('Request timeout');
				throw e;
			}
		};

		// 1) Get offer - prioritize listing.photoUrls which are already published/validated
		const offerUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
		let r = await fetchWithTimeout(offerUrl, { headers }, 5000);
		if (!r.ok) {
			console.error(`[offer-thumb] Offer fetch failed: ${r.status} for ${offerId}`);
			return { statusCode: r.status, body: `offer fetch failed: ${r.status}` };
		}
		const offer = await r.json();
		
		// Try listing photos first (already validated by eBay)
		const listingPhotos = offer?.listing?.photoUrls || offer?.listing?.imageUrls || [];
		const listingPhotoArr = Array.isArray(listingPhotos) ? listingPhotos : listingPhotos ? [listingPhotos] : [];
		
		let imageUrl: string | undefined = listingPhotoArr[0];
		
		if (imageUrl) {
			console.log(`[offer-thumb] Found listing photo for ${offerId}: ${imageUrl}`);
		}
		
		// Fallback: try inventory if no listing photos
		if (!imageUrl) {
			console.log(`[offer-thumb] No listing photo, trying inventory for ${offerId}`);
			const skuRaw: string | undefined = offer?.sku;
			if (!skuRaw) {
				console.warn(`[offer-thumb] No SKU found for offer ${offerId}`);
				return { statusCode: 204 };
			}

			const trySkus = [skuRaw];
			const san = skuRaw.replace(/[^A-Za-z0-9]/g, '').slice(0, 50);
			if (san && san !== skuRaw) trySkus.push(san);

			console.log(`[offer-thumb] Trying SKUs for ${offerId}: ${trySkus.join(', ')}`);

			for (const s of trySkus) {
				try {
					const invUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(s)}`;
					const ir = await fetchWithTimeout(invUrl, { headers }, 4000);
					if (!ir.ok) {
						console.warn(`[offer-thumb] Inventory fetch failed for SKU ${s}: ${ir.status}`);
						continue;
					}
					const item = await ir.json();
					const imgs = item?.product?.imageUrls || item?.product?.images || item?.product?.image || [];
					const arr = Array.isArray(imgs) ? imgs : imgs ? [imgs] : [];
					if (arr.length) {
						imageUrl = arr[0];
						console.log(`[offer-thumb] Found inventory photo for ${offerId} (SKU ${s}): ${imageUrl}`);
						break;
					} else {
						console.warn(`[offer-thumb] No images in inventory for SKU ${s}`);
					}
				} catch (err: any) {
					console.warn(`[offer-thumb] Inventory fetch error for SKU ${s}: ${err?.message}`);
					continue; // Skip failed inventory fetches
				}
			}
		}
		if (!imageUrl) {
			console.warn(`[offer-thumb] No image URL found for offer ${offerId}`);
			return { statusCode: 204 };
		}

		// Log the image URL type for debugging
		const isS3 = imageUrl.includes('.s3.') || imageUrl.includes('amazonaws.com');
		const isDropbox = imageUrl.includes('dropbox');
		console.log(`[offer-thumb] Image source for ${offerId}: ${isS3 ? 'S3' : isDropbox ? 'Dropbox' : 'Other'} - ${imageUrl.substring(0, 100)}...`);

		// normalize dropbox viewer links
		const toDirectDropbox = (u: string) => {
			try {
				const url = new URL(u);
				if (url.hostname === 'www.dropbox.com' || url.hostname === 'dropbox.com') {
					url.hostname = 'dl.dropboxusercontent.com';
					const qp = new URLSearchParams(url.search);
					qp.delete('dl');
					const qs = qp.toString();
					url.search = qs ? `?${qs}` : '';
					return url.toString();
				}
				return u;
			} catch {
				return u;
			}
		};
		
		const tryFetchImage = async (u: string) => {
			const resp = await fetchWithTimeout(u, { redirect: 'follow' }, 7000);
			const type = (resp.headers.get('content-type') || '').toLowerCase();
			const ok = resp.ok && type.startsWith('image/');
			const buf = ok ? Buffer.from(await resp.arrayBuffer()) : undefined;
			return { ok, resp, type, buf } as const;
		};
		
		let direct = toDirectDropbox(imageUrl);
		if (direct !== imageUrl) {
			console.log(`[offer-thumb] Normalized Dropbox URL for ${offerId}: ${imageUrl} -> ${direct}`);
		}
		
		let upstream = await tryFetchImage(direct);
		if (!upstream.ok) {
			console.warn(`[offer-thumb] Image fetch failed for ${offerId}: ${direct} (status: ${upstream.resp.status}, type: ${upstream.type})`);
			
			if (direct !== imageUrl) {
				// Retry original if normalized failed
				console.log(`[offer-thumb] Retrying with original URL for ${offerId}: ${imageUrl}`);
				try {
					upstream = await tryFetchImage(imageUrl);
					if (upstream.ok) {
						console.log(`[offer-thumb] Original URL succeeded for ${offerId}`);
					} else {
						console.warn(`[offer-thumb] Original URL also failed for ${offerId} (status: ${upstream.resp.status})`);
					}
				} catch (err: any) {
					console.error(`[offer-thumb] Both URLs failed for ${offerId}: ${err?.message}`);
					// If both fail, return 204 instead of 502
					return { statusCode: 204 };
				}
			}
		} else {
			console.log(`[offer-thumb] ✓ Successfully fetched image for ${offerId} (${upstream.type}, ${upstream.buf?.length} bytes)`);
		}
		
		if (!upstream.ok) {
			console.warn(`[offer-thumb] Returning 204 (no content) for ${offerId} - image unavailable`);
			// Return 204 (no content) instead of error to avoid 502s in UI
			return { statusCode: 204 };
		}
		return {
			statusCode: 200,
			headers: {
				'Content-Type': upstream.type,
				'Cache-Control': 'public, max-age=86400',
				'Access-Control-Allow-Origin': '*',
			},
			body: upstream.buf!.toString('base64'),
			isBase64Encoded: true,
		};
	} catch (e: any) {
		console.error(`[offer-thumb] Unexpected error for ${event.queryStringParameters?.offerId}: ${e?.message}`, e?.stack);
		// Return 204 instead of 500/502 to prevent broken image icons
		return { statusCode: 204 };
	}
};
