import type { Handler } from '@netlify/functions';

function escapeHtml(s: string) {
	return s.replace(/[&<>"]+/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
}

export const handler: Handler = async (event) => {
	try {
		const qs = event.queryStringParameters || {};
		const folder = (qs.path || qs.folder || '/EBAY') as string;
		const recursive = /^1|true|yes$/i.test(String(qs.recursive || '0'));
		const limit = Number(qs.limit || 0) || undefined;

		const baseProto = (event.headers?.['x-forwarded-proto'] || event.headers?.['X-Forwarded-Proto'] || 'https') as string;
		const baseHost = (event.headers?.['x-forwarded-host'] || event.headers?.['X-Forwarded-Host'] || event.headers?.host || event.headers?.Host) as string;
		const base = baseHost ? `${baseProto}://${baseHost}` : '';

		const apiUrl = new URL(`${base}/.netlify/functions/dropbox-list-images`);
		apiUrl.searchParams.set('path', folder);
		if (recursive) apiUrl.searchParams.set('recursive', '1');
		if (limit) apiUrl.searchParams.set('limit', String(limit));

		const r = await fetch(apiUrl.toString());
		const j: any = await r.json().catch(() => ({}));
		if (!r.ok || !j.ok) {
			return { statusCode: 500, headers: { 'Content-Type': 'text/html' }, body: `<h1>Error</h1><pre>${escapeHtml(JSON.stringify(j || {}, null, 2))}</pre>` };
		}

		const items: Array<{ name: string; proxiedUrl: string; path: string }> = j.items || [];
		const title = `Images in ${folder}`;
		const html = `<!doctype html>
<html>
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${escapeHtml(title)}</title>
	<style>
		body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 16px; }
		header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
		input[type=text] { padding: 6px 8px; min-width: 320px; }
		.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-top: 16px; }
		figure { margin: 0; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; background: #fafafa; }
		figure img { width: 100%; height: 220px; object-fit: cover; display: block; }
		figcaption { padding: 8px; font-size: 12px; color: #333; }
		.meta { color: #666; font-size: 11px; }
		.bar { display: flex; gap: 8px; }
		.bar a { text-decoration: none; color: #0a66c2; }
	</style>
</head>
<body>
	<header>
		<h1>${escapeHtml(title)}</h1>
		<form method="GET" action="/\.netlify/functions/view-images">
			<input type="text" name="path" value="${escapeHtml(folder)}" />
			<label><input type="checkbox" name="recursive" value="1" ${recursive ? 'checked' : ''}/> recursive</label>
			<input type="number" name="limit" value="${limit || ''}" placeholder="limit" />
			<button type="submit">Go</button>
		</form>
	</header>
	<div class="grid">
		${items
			.map(
				(it) => `
			<figure>
				<a href="${escapeHtml(it.proxiedUrl)}" target="_blank" rel="noopener noreferrer">
					<img src="${escapeHtml(it.proxiedUrl)}" alt="${escapeHtml(it.name)}" loading="lazy" />
				</a>
				<figcaption>
					<div>${escapeHtml(it.name)}</div>
					<div class="meta">${escapeHtml(it.path)}</div>
					<div class="bar">
						<a href="${escapeHtml(it.proxiedUrl)}" target="_blank" rel="noopener noreferrer">open</a>
					</div>
				</figcaption>
			</figure>`
			)
			.join('')}
	</div>
</body>
</html>`;

		return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: html };
	} catch (e: any) {
		return { statusCode: 500, headers: { 'Content-Type': 'text/html' }, body: `<h1>Error</h1><pre>${escapeHtml(e?.message || String(e))}</pre>` };
	}
};
