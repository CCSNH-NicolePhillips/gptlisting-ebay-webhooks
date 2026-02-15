import type { Handler } from '../../src/types/api-handler.js';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getFinalEbayPrice } from '../../src/lib/pricing-compute.js';

/**
 * All pricing logic lives in pricing-compute.ts - this is just a thin wrapper.
 */
function computeEbayPrice(base: number) {
	return getFinalEbayPrice(base);
}
function computeFloorPrice(ebayPrice: number) {
	const floor = ebayPrice * 0.8; // 20% off
	return Math.round(floor * 100) / 100;
}

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

async function listFiles(access: string, path: string) {
	const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
		method: 'POST',
		headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ path, recursive: false }),
	});
	const j: any = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(`dbx list: ${r.status} ${JSON.stringify(j)}`);
	return j.entries || [];
}

async function ensureSharedRawLink(access: string, filePath: string): Promise<string> {
	function normalize(u: string) {
		try {
			const url = new URL(u);
			if (/\.dropbox\.com$/i.test(url.hostname)) url.hostname = 'dl.dropboxusercontent.com';
			url.searchParams.delete('dl');
			url.searchParams.set('raw', '1');
			return url.toString();
		} catch {
			return u
				.replace('www.dropbox.com', 'dl.dropboxusercontent.com')
				.replace('?dl=0', '?raw=1')
				.replace('&dl=0', '&raw=1');
		}
	}
	const create = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
		method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath })
	});
	const cj: any = await create.json().catch(() => ({}));
	if (create.ok && cj?.url) return normalize(String(cj.url));
	if (cj?.error_summary?.includes('shared_link_already_exists')) {
		const r2 = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
			method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath, direct_only: true })
		});
		const j2: any = await r2.json().catch(() => ({}));
		if (!r2.ok || !j2.links?.length) throw new Error(`dbx links: ${r2.status} ${JSON.stringify(j2)}`);
		return normalize(String(j2.links[0].url));
	}
	throw new Error(`dbx share: ${create.status} ${JSON.stringify(cj)}`);
}

function deriveBaseUrlFromEvent(event: any): string | null {
	const hdrs = event?.headers || {};
	const proto = (hdrs['x-forwarded-proto'] || hdrs['X-Forwarded-Proto'] || 'https') as string;
	const host = (hdrs['x-forwarded-host'] || hdrs['X-Forwarded-Host'] || hdrs['host'] || hdrs['Host']) as string;
	if (host) return `${proto}://${host}`;
	return null;
}
function proxyUrl(u: string, base?: string | null) {
	const b = (process.env.APP_BASE_URL || base || '').toString();
	if (!b) return `/.netlify/functions/image-proxy?url=${encodeURIComponent(u)}`;
	return `${b}/.netlify/functions/image-proxy?url=${encodeURIComponent(u)}`;
}

export const handler: Handler = async (event) => {
	try {
		const qs = event.queryStringParameters || {};
		const folder = (qs.path || qs.folder || '/EBAY') as string;
		const sku = (qs.sku || qs.id || '') as string;
		if (!sku) return { statusCode: 400, body: 'Missing sku' };

		const store = tokensStore();
		const saved = (await store.get('dropbox.json', { type: 'json' })) as any;
		const refresh = saved?.refresh_token as string | undefined;
		if (!refresh) return { statusCode: 400, body: 'Connect Dropbox first' };
		const access = await dropboxAccessToken(refresh);
		const entries = await listFiles(access, folder);

		const files = entries.filter((e: any) => typeof e.name === 'string' && e.name.startsWith(sku + '_'));
		if (!files.length) return { statusCode: 404, body: 'SKU files not found' };

		const main = files.find((f: any) => f.name.toLowerCase().includes('_01')) || files.find((f: any) => /\.(jpe?g|png|webp)$/i.test(f.name));
		const gallery = files.filter((f: any) => f !== main && /\.(jpe?g|png|webp|gif|bmp|tiff)$/i.test(f.name))
			.sort((a: any, b: any) => a.name.localeCompare(b.name));
		const priceImg = files.find((f: any) => f.name.toLowerCase().includes('_price'));

	const derivedBase = deriveBaseUrlFromEvent(event);
	const toUrl = async (f: any) => proxyUrl(await ensureSharedRawLink(access, f.path_lower), derivedBase);
		const images = main ? [await toUrl(main), ...(await Promise.all(gallery.map(toUrl)))] : [];
	const priceUrl = priceImg ? await ensureSharedRawLink(access, priceImg.path_lower) : undefined;

		// Extract base price from _price filename if present
		let basePrice = 0;
		if (priceImg) {
			const m = String(priceImg.name).match(/([0-9]+(?:\.[0-9]{1,2})?)/);
			if (m) basePrice = Number(m[1]);
		}
		const ebayPrice = computeEbayPrice(basePrice);
		const floorPrice = computeFloorPrice(ebayPrice);

		const plan = {
			sku,
			folder,
			images,
	priceImage: priceUrl ? proxyUrl(priceUrl, derivedBase) : undefined,
			pricing: {
				basePrice,
				ebayPrice,
				floorPrice,
				markdown: {
					everyDays: 3,
					amount: 1,
					stopAt: floorPrice,
				},
				promotePercent: 2,
			},
			draftPayloadTemplate: {
				// agent fills title/description/features/aspects
				sku,
				images,
				price: ebayPrice,
				qty: 1,
				marketplaceId: process.env.EBAY_MARKETPLACE_ID || 'EBAY_US',
			},
		};

		return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, plan }) };
	} catch (e: any) {
		return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e?.message || String(e) }) };
	}
};