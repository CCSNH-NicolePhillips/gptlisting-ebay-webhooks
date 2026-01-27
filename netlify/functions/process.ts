import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getJwtSubUnverified, userScopedKey, getBearerToken } from '../../src/lib/_auth.js';

// Minimal placeholder: returns ok when both tokens exist.
// Later we can port the full /process logic here if desired.
export const handler: Handler = async (event) => {
	const tokens = tokensStore();
	const bearer = getBearerToken(event);
	const sub = getJwtSubUnverified(event);
	if (!bearer || !sub) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
	const [dbx, ebay] = await Promise.all([
		tokens.get(userScopedKey(sub, 'dropbox.json'), { type: 'json' }) as Promise<any>,
		tokens.get(userScopedKey(sub, 'ebay.json'), { type: 'json' }) as Promise<any>,
	]);
	if (!dbx?.refresh_token || !ebay?.refresh_token) {
		return {
			statusCode: 400,
			body: JSON.stringify({ ok: false, error: 'Connect Dropbox and eBay first' }),
		};
	}
	// TODO: call your existing logic to create drafts (from Express src/routes/process.ts)
	return { statusCode: 200, body: JSON.stringify({ ok: true, created: 0 }) };
};
