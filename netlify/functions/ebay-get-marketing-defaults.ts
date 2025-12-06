import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
	try {
		const bearer = getBearerToken(event);
		let sub = (await requireAuthVerified(event))?.sub || null;
		if (!sub) sub = getJwtSubUnverified(event);
		if (!bearer || !sub) return { statusCode: 401, body: 'Unauthorized' };

		const store = tokensStore();
		const key = userScopedKey(sub, 'marketing-defaults.json');
		
		let prefs: any = {};
		try {
			prefs = (await store.get(key, { type: 'json' })) as any;
		} catch {}
		if (!prefs || typeof prefs !== 'object') prefs = {};
		
		// Normalize to a predictable shape
		const defaults = {
			defaultPromoCampaignId: prefs.defaultPromoCampaignId ?? null,
		};
		
		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ok: true, defaults }),
		};
	} catch (e: any) {
		return {
			statusCode: 500,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ok: false, error: e?.message || String(e) }),
		};
	}
};
