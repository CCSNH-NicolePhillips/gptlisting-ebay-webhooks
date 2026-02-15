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
		const qs = event.queryStringParameters || {};
		const path = (qs.path || '') as string;

		const store = tokensStore();
		const bearer = getBearerToken(event);
		const sub = getJwtSubUnverified(event);
		if (!bearer || !sub) return { statusCode: 401, body: 'Unauthorized' };
		const saved = (await store.get(userScopedKey(sub, 'dropbox.json'), { type: 'json' })) as any;
		const refresh = saved?.refresh_token as string | undefined;
		if (!refresh) return { statusCode: 400, body: 'Connect Dropbox first' };
		const access = await dropboxAccessToken(refresh);

		// List files in the specified folder (non-recursive)
		const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
			method: 'POST',
			headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ path, recursive: false }),
		});
		const j: any = await r.json().catch(() => ({}));
		if (!r.ok) return { statusCode: r.status, body: JSON.stringify(j) };

		// Filter for files only (not folders)
		const files = (j.entries || []).filter((e: any) => e['.tag'] === 'file');

		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ok: true, path, count: files.length, files }),
		};
	} catch (e: any) {
		console.error('dropbox-list-files error:', e);
		return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
	}
};
