import type { Handler } from '../../src/types/api-handler.js';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getJwtSubUnverified, userScopedKey, getBearerToken, requireAuthVerified } from '../../src/lib/_auth.js';
import { getUserStats } from '../../src/lib/user-stats.js';

export const handler: Handler = async (event) => {
	try {
		const tokens = tokensStore();
		const bearer = getBearerToken(event);
		const authResult = await requireAuthVerified(event);
		let sub = authResult?.sub || null;
		if (!sub) sub = getJwtSubUnverified(event); // fallback if verification disabled/missing
		if (!bearer) {
			return { statusCode: 401, body: 'Unauthorized: missing Authorization' };
		}
		if (!sub) {
			return { statusCode: 401, body: 'Unauthorized: invalid token' };
		}
		
		// Extract user info from JWT claims
		const userClaims = authResult?.claims || {};
		const user = {
			name: typeof userClaims?.name === 'string' ? userClaims.name : undefined,
			email: typeof userClaims?.email === 'string' ? userClaims.email : undefined,
			given_name: typeof userClaims?.given_name === 'string' ? userClaims.given_name : undefined,
			preferred_username: typeof userClaims?.preferred_username === 'string' ? userClaims.preferred_username : undefined,
		};
		if (event.httpMethod === 'POST') {
			if (event.queryStringParameters?.dropbox === 'disconnect') {
				const key = userScopedKey(sub, 'dropbox.json');
				await tokens.setJSON(key, {});
				return { statusCode: 200, body: JSON.stringify({ ok: true }) };
			}
			if (event.queryStringParameters?.ebay === 'disconnect') {
				const key = userScopedKey(sub, 'ebay.json');
				await tokens.setJSON(key, {});
				return { statusCode: 200, body: JSON.stringify({ ok: true }) };
			}
		}

		const [dbx, ebay, stats] = await Promise.all([
			tokens.get(userScopedKey(sub, 'dropbox.json'), { type: 'json' }) as Promise<any>,
			tokens.get(userScopedKey(sub, 'ebay.json'), { type: 'json' }) as Promise<any>,
			getUserStats(sub),
		]);

		console.log('[status] User status check:', { 
			sub, 
			key: userScopedKey(sub, 'ebay.json'),
			ebayConnected: !!(ebay as any)?.refresh_token,
			ebayData: ebay ? 'has data' : 'null'
		});

		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				dropbox: { connected: !!(dbx as any)?.refresh_token },
				ebay: { connected: !!(ebay as any)?.refresh_token },
				stats,
				user,
			}),
		};
	} catch (e: any) {
		return { statusCode: 500, body: `status error: ${e.message}` };
	}
};
