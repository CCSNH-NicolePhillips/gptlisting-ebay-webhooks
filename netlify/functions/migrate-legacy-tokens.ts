import type { Handler } from '../../src/types/api-handler.js';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getJwtSubUnverified, userScopedKey } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
	try {
		const sub = getJwtSubUnverified(event);
		if (!sub) {
			return { statusCode: 401, body: 'Unauthorized: login required' };
		}
		const store = tokensStore();
		const userDbxKey = userScopedKey(sub, 'dropbox.json');
		const userEbayKey = userScopedKey(sub, 'ebay.json');
		const [uDbx, uEbay, gDbx, gEbay] = await Promise.all([
			store.get(userDbxKey, { type: 'json' }) as Promise<any>,
			store.get(userEbayKey, { type: 'json' }) as Promise<any>,
			store.get('dropbox.json', { type: 'json' }) as Promise<any>,
			store.get('ebay.json', { type: 'json' }) as Promise<any>,
		]);
		let migDbx = false;
		let migEbay = false;
		if (!uDbx?.refresh_token && gDbx?.refresh_token) {
			await store.setJSON(userDbxKey, { refresh_token: gDbx.refresh_token });
			migDbx = true;
		}
		if (!uEbay?.refresh_token && gEbay?.refresh_token) {
			await store.setJSON(userEbayKey, { refresh_token: gEbay.refresh_token });
			migEbay = true;
		}
		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ok: true, migrated: { dropbox: migDbx, ebay: migEbay } }),
		};
	} catch (e: any) {
		return { statusCode: 500, body: `migrate error: ${e.message}` };
	}
};
