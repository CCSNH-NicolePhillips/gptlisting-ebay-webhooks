import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/_blobs.js';
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
		const path = (qs.path || qs.folder || '') as string; // '' lists root
		const recursive = /^1|true|yes$/i.test(String(qs.recursive || '0'));

	const store = tokensStore();
	const bearer = getBearerToken(event);
	const sub = getJwtSubUnverified(event);
	if (!bearer || !sub) return { statusCode: 401, body: 'Unauthorized' };
	const saved = (await store.get(userScopedKey(sub, 'dropbox.json'), { type: 'json' })) as any;
		const refresh = saved?.refresh_token as string | undefined;
		if (!refresh) return { statusCode: 400, body: 'Connect Dropbox first' };
		const access = await dropboxAccessToken(refresh);

		const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
			method: 'POST',
			headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ path, recursive }),
		});
		const j: any = await r.json().catch(() => ({}));
		if (!r.ok) return { statusCode: r.status, body: JSON.stringify(j) };
		const folders = (j.entries || []).filter((e: any) => e['.tag'] === 'folder');
		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ok: true, path, recursive, count: folders.length, folders }),
		};
	} catch (e: any) {
		return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e?.message || String(e) }) };
	}
};
