import type { Handler } from '../../src/types/api-handler.js';
import { requireAuth, json } from '../../src/lib/_auth.js';
import { getUserAccessToken, apiHost, headers } from '../../src/lib/_ebay.js';

export const handler: Handler = async (event) => {
	try {
		const auth = await requireAuth(event);
		if (!auth) return json({ error: 'unauthorized' }, 401);

		let token: string;
		try {
			token = await getUserAccessToken(auth.sub);
		} catch (err: any) {
			if (err?.code === 'ebay-not-connected') return json({ error: 'ebay-not-connected' }, 400);
			return json({ error: 'token-mint-failed', detail: err?.message || String(err) }, 500);
		}

		const body = event.body ? JSON.parse(event.body) : {};
		const qs = event.queryStringParameters || {};
		const rawKey = (body.key || qs.key || process.env.EBAY_MERCHANT_LOCATION_KEY || 'default-loc').toString();
		const key = rawKey.trim();
		if (!key) return json({ error: 'missing-key' }, 400);

		const url = `${apiHost()}/sell/inventory/v1/location/${encodeURIComponent(key)}`;
		const res = await fetch(url, { method: 'DELETE', headers: headers(token) });
		const text = await res.text();
		let payload: any;
		try {
			payload = JSON.parse(text);
		} catch {
			payload = text ? { raw: text } : null;
		}

		if (res.status === 204 || res.status === 200 || res.status === 202 || res.status === 404) {
			return json({ ok: true, deleted: key, status: res.status, detail: payload ?? undefined });
		}

		return json(
			{ ok: false, error: 'delete-location-failed', status: res.status, detail: payload ?? undefined },
			res.status
		);
	} catch (err: any) {
		return json({ error: err?.message || String(err) }, 500);
	}
};