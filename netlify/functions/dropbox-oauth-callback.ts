import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/_blobs.js';
import { consumeOAuthState } from '../../src/lib/_auth.js';

function sanitizeReturnTo(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	let candidate = value.trim();
	if (!candidate) return null;
	if (/^https?:\/\//i.test(candidate)) {
		try {
			const url = new URL(candidate);
			candidate = `${url.pathname || '/'}`;
			if (url.search) candidate += url.search;
			if (url.hash) candidate += url.hash;
		} catch {
			return null;
		}
	}
	if (!candidate.startsWith('/')) return null;
	return candidate;
}

export const handler: Handler = async (event) => {
	try {
	const code = event.queryStringParameters?.code;
		if (!code) return { statusCode: 400, body: 'Missing ?code' };
	const state = event.queryStringParameters?.state || null;
	const stateInfo = await consumeOAuthState(state || null);
	if (!stateInfo?.sub) return { statusCode: 400, body: 'Invalid or expired state. Start connect from the app while signed in.' };

		const clientId = process.env.DROPBOX_CLIENT_ID!;
		const clientSecret = process.env.DROPBOX_CLIENT_SECRET!;
		const redirectUri = process.env.DROPBOX_REDIRECT_URI!;

		const body = new URLSearchParams({
			code,
			grant_type: 'authorization_code',
			redirect_uri: redirectUri,
		});

		const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
			method: 'POST',
			headers: {
				Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body,
		});

		const data = await res.json();
		if (!res.ok) {
			return { statusCode: res.status, body: `Dropbox token error: ${JSON.stringify(data)}` };
		}

		const refreshToken = data.refresh_token as string | undefined;
		if (!refreshToken) {
			return { statusCode: 400, body: 'No refresh_token returned' };
		}

	const tokens = tokensStore();
	const key = `users/${encodeURIComponent(stateInfo.sub)}/dropbox.json`;
	await tokens.setJSON(key, { refresh_token: refreshToken });

	const redirectTo = sanitizeReturnTo(stateInfo.returnTo) || '/index.html';

		return { statusCode: 302, headers: { Location: redirectTo } };
	} catch (e: any) {
		return { statusCode: 500, body: `Dropbox OAuth error: ${e.message}` };
	}
};
