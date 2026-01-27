import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
	try {
		const offerId = event.queryStringParameters?.offerId || event.queryStringParameters?.id;
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
			'Accept-Language': 'en-US',
			'Content-Language': 'en-US',
			'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
		} as Record<string, string>;

		const url = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
		const r = await fetch(url, { headers });
		const txt = await r.text();
		let json: any;
		try {
			json = JSON.parse(txt);
		} catch {
			json = { raw: txt };
		}
		if (!r.ok)
			return {
				statusCode: r.status,
				body: JSON.stringify({ error: 'get-offer failed', url, status: r.status, detail: json }),
			};
		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ok: true, offer: json }),
		};
	} catch (e: any) {
		return {
			statusCode: 500,
			body: JSON.stringify({ error: 'get-offer error', detail: e?.message || String(e) }),
		};
	}
};