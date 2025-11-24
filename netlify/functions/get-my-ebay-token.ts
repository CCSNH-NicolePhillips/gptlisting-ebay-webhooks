import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/_blobs.js';
import { requireAuthVerified } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
	try {
		const auth = await requireAuthVerified(event);
		if (!auth?.sub) {
			return {
				statusCode: 401,
				body: JSON.stringify({ error: 'Unauthorized' }),
			};
		}

		const tokens = tokensStore();
		const key = `users/${encodeURIComponent(auth.sub)}/ebay.json`;
		const data: any = await tokens.getJSON(key);

		if (!data?.refresh_token) {
			return {
				statusCode: 404,
				body: JSON.stringify({ error: 'No eBay token found. Please connect eBay first.' }),
			};
		}

		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				refresh_token: data.refresh_token,
				message: 'Copy this token and use it with: node delete-broken-drafts-direct.mjs YOUR_TOKEN',
			}),
		};
	} catch (e: any) {
		return {
			statusCode: 500,
			body: JSON.stringify({ error: e.message }),
		};
	}
};
