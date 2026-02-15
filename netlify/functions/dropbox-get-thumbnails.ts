import type { Handler } from '../../src/types/api-handler.js';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getJwtSubUnverified, userScopedKey, getBearerToken } from '../../src/lib/_auth.js';

async function dropboxAccessToken(refreshToken: string) {
	const form = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: process.env.DROPBOX_CLIENT_ID || '',
		client_secret: process.env.DROPBOX_CLIENT_SECRET || '',
	});
	const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: form.toString(),
	});
	const j: any = await r.json().catch(() => ({}));
	if (!r.ok || !j.access_token) throw new Error(`dbx token: ${r.status} ${JSON.stringify(j)}`);
	return j.access_token as string;
}

export const handler: Handler = async (event) => {
	try {
		if (event.httpMethod !== 'POST') {
			return { statusCode: 405, body: 'Method not allowed' };
		}

		const body = JSON.parse(event.body || '{}');
		const filePaths = body.files as string[] | undefined;

		if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
			return { statusCode: 400, body: 'Missing or invalid files array' };
		}

		const store = tokensStore();
		const bearer = getBearerToken(event);
		const sub = getJwtSubUnverified(event);
		if (!bearer || !sub) return { statusCode: 401, body: 'Unauthorized' };
		const saved = (await store.get(userScopedKey(sub, 'dropbox.json'), { type: 'json' })) as any;
		const refresh = saved?.refresh_token as string | undefined;
		if (!refresh) return { statusCode: 400, body: 'Connect Dropbox first' };
		const access = await dropboxAccessToken(refresh);

		// Get temporary links for each file (thumbnails)
		// Dropbox API: https://api.dropboxapi.com/2/files/get_temporary_link
		const thumbnails = await Promise.all(
			filePaths.map(async (path) => {
				try {
					const r = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
						method: 'POST',
						headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
						body: JSON.stringify({ path }),
					});
					const j: any = await r.json().catch(() => ({}));
					if (!r.ok) {
						console.error(`Failed to get thumbnail for ${path}:`, j);
						return { path, link: null, error: j.error_summary };
					}
					return { path, link: j.link };
				} catch (err) {
					console.error(`Error getting thumbnail for ${path}:`, err);
					return { path, link: null, error: String(err) };
				}
			})
		);

		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ok: true, thumbnails }),
		};
	} catch (e: any) {
		console.error('dropbox-get-thumbnails error:', e);
		return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
	}
};
