import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';

function json(body: any, status: number = 200) {
	return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const handler: Handler = async (event) => {
	try {
		// Verify caller has a bearer token and extract user sub
		const bearer = getBearerToken(event);
		let sub = (await requireAuthVerified(event))?.sub || null;
		if (!sub) sub = getJwtSubUnverified(event);
		if (!bearer || !sub) return json({ ok: false, error: 'Unauthorized' }, 401);

		// Load user's eBay refresh token
		const store = tokensStore();
		const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
		const refresh = saved?.refresh_token as string | undefined;
		if (!refresh) return json({ ok: false, error: 'Connect eBay first' }, 400);

		// Mint user access token with sell.account scope for Account API
		const scopes = [
			'https://api.ebay.com/oauth/api_scope',
			'https://api.ebay.com/oauth/api_scope/sell.account',
		];
		const { access_token } = await accessTokenFromRefresh(refresh, scopes);

		const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
		const { apiHost } = tokenHosts(process.env.EBAY_ENV);
		const hdrs = {
			Authorization: `Bearer ${access_token}`,
			Accept: 'application/json',
			'Content-Language': 'en-US',
			'Accept-Language': 'en-US',
			'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
		} as Record<string, string>;

		// Smoke test: list payment policies
		const url = `${apiHost}/sell/account/v1/payment_policy?marketplace_id=${MARKETPLACE_ID}`;
		const r = await fetch(url, { headers: hdrs });
		const txt = await r.text();
		let body: any; try { body = JSON.parse(txt); } catch { body = txt; }
		const www = r.headers.get('www-authenticate') || '';
		return json({ ok: r.ok, status: r.status, wwwAuthenticate: www, url, body }, r.status);
	} catch (e: any) {
		return json({ ok: false, error: 'debug failed', detail: e?.message || String(e) }, 500);
	}
};