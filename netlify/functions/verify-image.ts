import type { Handler } from '@netlify/functions';

export const handler: Handler = async (event) => {
	const url = event.queryStringParameters?.url;
	if (!url) return { statusCode: 400, body: 'Missing ?url=' };
	try {
		const r = await fetch(url, { method: 'GET', redirect: 'follow' });
		const type = r.headers.get('content-type') || '';
		const len = r.headers.get('content-length') || '';
		const ok = r.ok && type.startsWith('image/');
		const body = await r.arrayBuffer();
		return {
			statusCode: ok ? 200 : 422,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				ok,
				status: r.status,
				contentType: type,
				contentLength: len,
				sizeBytes: body.byteLength,
				finalUrl: r.url,
			}),
		};
	} catch (e: any) {
		return {
			statusCode: 502,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ok: false, error: e?.message || String(e) }),
		};
	}
};