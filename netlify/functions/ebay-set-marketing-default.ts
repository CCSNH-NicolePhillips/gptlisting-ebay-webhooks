import type { Handler } from '../../src/types/api-handler.js';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
	try {
		const bearer = getBearerToken(event);
		let sub = (await requireAuthVerified(event))?.sub || null;
		if (!sub) sub = getJwtSubUnverified(event);
		if (!bearer || !sub) {
			return { statusCode: 401, body: 'Unauthorized' };
		}

		if (event.httpMethod !== 'POST') {
			return { statusCode: 405, body: 'Method Not Allowed' };
		}

		const store = tokensStore();
		const key = userScopedKey(sub, 'marketing-defaults.json');

		const body = event.body ? JSON.parse(event.body) : {};
		const defaultPromoCampaignId = body.defaultPromoCampaignId ?? null;

		let prefs: any = {};
		try {
			prefs = (await store.get(key, { type: 'json' })) as any;
		} catch {}
		if (!prefs || typeof prefs !== 'object') prefs = {};

		prefs.defaultPromoCampaignId = defaultPromoCampaignId;

		await store.set(key, JSON.stringify(prefs));

		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ok: true, defaultPromoCampaignId }),
		};
	} catch (e: any) {
		return {
			statusCode: 500,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ok: false, error: e?.message || String(e) }),
		};
	}
};
