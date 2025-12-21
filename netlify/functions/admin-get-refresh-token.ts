import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

/**
 * Admin endpoint to get eBay refresh token for local script use
 * Requires authentication
 */
export const handler: Handler = async (event) => {
	try {
		// Require authentication
		const bearer = getBearerToken(event);
		const auth = await requireAuthVerified(event);
		const sub = auth?.sub;
		
		if (!bearer || !sub) {
			return {
				statusCode: 401,
				body: JSON.stringify({ error: 'Unauthorized' })
			};
		}
		
		// Get eBay token from storage
		const store = tokensStore();
		const saved = await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' }) as any;
		
		if (!saved?.refresh_token) {
			return {
				statusCode: 404,
				body: JSON.stringify({ error: 'No eBay token found. Connect eBay first.' })
			};
		}
		
		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				refresh_token: saved.refresh_token,
				instructions: 'Run: node scripts/delete-drafts-simple.mjs YOUR_REFRESH_TOKEN'
			})
		};
	} catch (e: any) {
		console.error('[admin-get-refresh-token] Error:', e);
		return {
			statusCode: 500,
			body: JSON.stringify({ error: e?.message || String(e) })
		};
	}
};
