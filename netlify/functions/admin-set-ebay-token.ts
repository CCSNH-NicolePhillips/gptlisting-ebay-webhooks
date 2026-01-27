import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified } from '../../src/lib/_auth.js';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';

/**
 * Admin endpoint to store an eBay refresh token directly.
 * Useful for restoring a connection when the stored token is missing/expired.
 * 
 * POST with JSON body: { "refresh_token": "v^1.1#..." }
 * 
 * The endpoint validates the token works before storing it.
 */
export const handler: Handler = async (event) => {
	const headers = { 'Content-Type': 'application/json' } as Record<string, string>;

	if (event.httpMethod === 'OPTIONS') {
		return { statusCode: 204, headers };
	}

	if (event.httpMethod !== 'POST') {
		return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
	}

	try {
		// Authenticate user
		const bearer = getBearerToken(event);
		let sub = (await requireAuthVerified(event))?.sub || null;
		if (!sub) sub = getJwtSubUnverified(event);
		if (!bearer || !sub) {
			return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
		}

		// Parse body
		let body: any = {};
		try {
			body = JSON.parse(event.body || '{}');
		} catch {
			return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
		}

		const refreshToken = body.refresh_token;
		if (!refreshToken || typeof refreshToken !== 'string') {
			return { 
				statusCode: 400, 
				headers, 
				body: JSON.stringify({ error: 'Missing refresh_token in body' }) 
			};
		}

		// Validate the token works by getting an access token
		console.log(`[admin-set-ebay-token] Testing refresh token for user ${sub}`);
		let accessToken: string;
		try {
			const result = await accessTokenFromRefresh(refreshToken);
			accessToken = result.access_token;
		} catch (e: any) {
			console.error('[admin-set-ebay-token] Token validation failed:', e.message);
			return { 
				statusCode: 400, 
				headers, 
				body: JSON.stringify({ 
					error: 'Invalid eBay refresh token', 
					detail: e.message 
				}) 
			};
		}

		// Further validate by calling eBay API
		const ENV = process.env.EBAY_ENV || 'PROD';
		const { apiHost } = tokenHosts(ENV);
		const testRes = await fetch(`${apiHost}/sell/inventory/v1/inventory_item?limit=1`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: 'application/json',
			},
		});

		if (!testRes.ok) {
			const errorText = await testRes.text();
			console.error('[admin-set-ebay-token] API test failed:', testRes.status, errorText);
			return { 
				statusCode: 400, 
				headers, 
				body: JSON.stringify({ 
					error: 'Token rejected by eBay API', 
					status: testRes.status,
					detail: errorText.slice(0, 500)
				}) 
			};
		}

		// Token is valid - store it
		const tokens = tokensStore();
		const key = `users/${encodeURIComponent(sub)}/ebay.json`;
		await tokens.setJSON(key, { refresh_token: refreshToken });

		console.log(`[admin-set-ebay-token] Stored refresh token for user ${sub}`);

		return {
			statusCode: 200,
			headers,
			body: JSON.stringify({
				ok: true,
				message: 'eBay token stored successfully',
				user: sub,
				env: ENV,
			}),
		};
	} catch (e: any) {
		console.error('[admin-set-ebay-token] Error:', e);
		return {
			statusCode: 500,
			headers,
			body: JSON.stringify({ error: e.message }),
		};
	}
};
