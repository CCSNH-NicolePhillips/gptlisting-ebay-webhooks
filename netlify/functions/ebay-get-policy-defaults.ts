import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
	try {
		const bearer = getBearerToken(event);
		let sub = (await requireAuthVerified(event))?.sub || null;
		if (!sub) sub = getJwtSubUnverified(event);
		if (!bearer || !sub) return { statusCode: 401, body: 'Unauthorized' };

		const store = tokensStore();
		let prefs: any = {};
		try {
			prefs = (await store.get(userScopedKey(sub, 'policy-defaults.json'), { type: 'json' })) as any;
		} catch {}
		if (!prefs || typeof prefs !== 'object') prefs = {};
		return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, defaults: prefs }) };
	} catch (e: any) {
		return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e?.message || String(e) }) };
	}
};