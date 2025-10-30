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
		if (!stateInfo?.sub) {
			const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' } as Record<string, string>;
			return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'invalid_state', hint: 'Start eBay connect from the app while signed in' }) };
		}

		const env = process.env.EBAY_ENV || 'PROD';
		const tokenHost = env === 'SANDBOX' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
		const basic = Buffer.from(
			`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
		).toString('base64');

		const body = new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: (process.env.EBAY_RUNAME || process.env.EBAY_RU_NAME)!,
		});

		const res = await fetch(`${tokenHost}/identity/v1/oauth2/token`, {
			method: 'POST',
			headers: {
				Authorization: `Basic ${basic}`,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body,
		});

		const text = await res.text();
		let data: any = {};
		try {
			data = JSON.parse(text);
		} catch {
			data = { raw: text };
		}

		if (!res.ok) {
			console.error('eBay token exchange failed', {
				status: res.status,
				env,
				tokenHost,
				has_error: !!data.error || !!data.error_description,
				data,
			});
			const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' } as Record<
				string,
				string
			>;
			return {
				statusCode: 400,
				headers: jsonHeaders,
				body: JSON.stringify({
					error: 'eBay token error',
					status: res.status,
					detail: data,
					hint: "Ensure EBAY_ENV=PROD matches your RUName (Production) and the RUName's redirect URL points to /.netlify/functions/ebay-oauth-callback",
				}),
			};
		}

		console.log('OAuth tokens:', {
			has_refresh: !!data.refresh_token,
			has_access: !!data.access_token,
		});

		if (!data.refresh_token) {
			// Surface a helpful error so we can correct ENV/RUName/scopes
			const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' } as Record<
				string,
				string
			>;
			return {
				statusCode: 400,
				headers: jsonHeaders,
				body: JSON.stringify({
					error: 'No refresh_token returned',
					hint: 'Confirm EBAY_RUNAME is Production RUName with redirect to /.netlify/functions/ebay-oauth-callback, EBAY_ENV=PROD, and scopes include sell.account and sell.inventory',
					data,
				}),
			};
		}

	const tokens = tokensStore();
	const key = `users/${encodeURIComponent(stateInfo.sub)}/ebay.json`;
	await tokens.setJSON(key, { refresh_token: data.refresh_token });
		const redirectPath = sanitizeReturnTo(stateInfo.returnTo) || '/index.html';
		const redirectHeaders = { Location: redirectPath } as Record<string, string>;
		return { statusCode: 302, headers: redirectHeaders };
	} catch (e: any) {
		return { statusCode: 500, body: `OAuth error: ${e.message}` };
	}
};
