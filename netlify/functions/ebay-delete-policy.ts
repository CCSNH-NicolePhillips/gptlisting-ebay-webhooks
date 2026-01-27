import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/redis-store.js';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
	try {
		const bearer = getBearerToken(event);
		let sub = (await requireAuthVerified(event))?.sub || null;
		if (!sub) sub = getJwtSubUnverified(event);
		if (!bearer || !sub) return { statusCode: 401, body: 'Unauthorized' };

		const qs = event.queryStringParameters || {};
		const body = event.body ? JSON.parse(event.body) : {};
		const typeRaw = (qs.type || body.type || '').toString().toLowerCase();
		const id = (qs.id || body.id || '').toString().trim();
		if (!id || !typeRaw) return { statusCode: 400, body: JSON.stringify({ error: 'missing type or id' }) };

		const typeMap: Record<string, string> = {
			fulfillment: 'fulfillment_policy',
			shipping: 'fulfillment_policy',
			payment: 'payment_policy',
			return: 'return_policy',
			returns: 'return_policy',
		};
		const pathType = typeMap[typeRaw];
		if (!pathType) return { statusCode: 400, body: JSON.stringify({ error: 'invalid type' }) };

		const store = tokensStore();
		const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
		const refresh = saved?.refresh_token as string | undefined;
		if (!refresh)
			return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Connect eBay first' }) };

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

		const url = `${apiHost}/sell/account/v1/${pathType}/${encodeURIComponent(id)}`;
		const r = await fetch(url, { method: 'DELETE', headers });
		const txt = await r.text();
		let json: any;
		try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
		if (!r.ok) return { statusCode: r.status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'delete-policy failed', url, status: r.status, detail: json }) };
		return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, deleted: { type: pathType, id } }) };
	} catch (e: any) {
		return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e?.message || String(e) }) };
	}
};