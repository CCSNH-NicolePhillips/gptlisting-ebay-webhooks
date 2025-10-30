import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getJwtSubUnverified, userScopedKey, getBearerToken, requireAuthVerified } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
	try {
		const tokens = tokensStore();
		const bearer = getBearerToken(event);
		let sub = (await requireAuthVerified(event))?.sub || null;
		if (!sub) sub = getJwtSubUnverified(event); // fallback if verification disabled/missing
		if (!bearer) {
			return { statusCode: 401, body: 'Unauthorized: missing Authorization' };
		}
		if (!sub) {
			return { statusCode: 401, body: 'Unauthorized: invalid token' };
		}
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

		const [dbx, ebay] = await Promise.all([
			tokens.get(userScopedKey(sub, 'dropbox.json'), { type: 'json' }) as Promise<any>,
			tokens.get(userScopedKey(sub, 'ebay.json'), { type: 'json' }) as Promise<any>,
		]);

		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				dropbox: { connected: !!(dbx as any)?.refresh_token },
				ebay: { connected: !!(ebay as any)?.refresh_token },
			}),
		};
	} catch (e: any) {
		return { statusCode: 500, body: `status error: ${e.message}` };
	}
};
