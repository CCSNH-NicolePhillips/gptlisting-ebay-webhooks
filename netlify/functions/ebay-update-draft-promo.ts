import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';
import { storePromotionIntent, deletePromotionIntent } from '../../src/lib/promotion-queue.js';

/**
 * Update draft promotion intent settings
 * POST /.netlify/functions/ebay-update-draft-promo
 * Body: { offerId, autoPromote, autoPromoteAdRate }
 */
export const handler: Handler = async (event) => {
	try {
		if (event.httpMethod !== 'POST') {
			return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
		}

		const body = JSON.parse(event.body || '{}');
		const { offerId, autoPromote, autoPromoteAdRate } = body;

		if (!offerId) {
			return { statusCode: 400, body: JSON.stringify({ error: 'missing offerId' }) };
		}

		// Auth
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
			'Content-Type': 'application/json',
		} as Record<string, string>;

		// 1. Get existing offer
		const getUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
		const getR = await fetch(getUrl, { headers });
		const getText = await getR.text();
		let offer: any;
		try {
			offer = JSON.parse(getText);
		} catch {
			return {
				statusCode: 500,
				body: JSON.stringify({ error: 'Failed to parse offer response', detail: getText }),
			};
		}

		if (!getR.ok) {
			return {
				statusCode: getR.status,
				body: JSON.stringify({ error: 'Failed to get offer', detail: offer }),
			};
		}

		// 2. Update merchantData with promotion intent
		if (!offer.merchantData) {
			offer.merchantData = {};
		}

		// Store promotion intent in merchantData
		if (typeof autoPromote === 'boolean') {
			offer.merchantData.autoPromote = autoPromote;
		}
		if (typeof autoPromoteAdRate === 'number') {
			offer.merchantData.autoPromoteAdRate = autoPromoteAdRate;
		}

		// Track modification
		offer.merchantData.lastModified = new Date().toISOString();

		// 3. PUT updated offer back to eBay
		const putUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
		const putR = await fetch(putUrl, {
			method: 'PUT',
			headers,
			body: JSON.stringify(offer),
		});

		const putText = await putR.text();
		let putData: any;
		try {
			putData = putText ? JSON.parse(putText) : {};
		} catch {
			putData = { raw: putText };
		}

		if (!putR.ok) {
			return {
				statusCode: putR.status,
				body: JSON.stringify({ error: 'Failed to update offer', detail: putData }),
			};
		}

		// Store promotion intent in Redis (this is what ebay-publish-offer reads)
		// eBay doesn't persist merchantData, so we use Redis to bridge the gap
		try {
			if (autoPromote === true) {
				const adRate = typeof autoPromoteAdRate === 'number' ? autoPromoteAdRate : 5;
				await storePromotionIntent(offerId, true, adRate);
				console.log(`[ebay-update-draft-promo] ✓ Stored promotion intent in Redis for offerId ${offerId}: adRate=${adRate}%`);
			} else if (autoPromote === false) {
				// Explicitly disabled - delete any existing intent
				await deletePromotionIntent(offerId);
				console.log(`[ebay-update-draft-promo] ✓ Deleted promotion intent from Redis for offerId ${offerId}`);
			}
		} catch (redisErr: any) {
			console.error(`[ebay-update-draft-promo] ⚠️ Failed to update Redis promotion intent for ${offerId}:`, redisErr?.message || redisErr);
			// Don't fail the whole request - eBay update succeeded
		}

		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				ok: true,
				offerId,
				autoPromote: offer.merchantData.autoPromote,
				autoPromoteAdRate: offer.merchantData.autoPromoteAdRate,
			}),
		};
	} catch (e: any) {
		return {
			statusCode: 500,
			body: JSON.stringify({ error: 'update-draft-promo error', detail: e?.message || String(e) }),
		};
	}
};
