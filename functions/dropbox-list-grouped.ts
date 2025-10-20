import type { Handler } from '@netlify/functions';
import { tokensStore } from './_blobs.js';

type DbxEntry = {
  name: string;
  id: string;
  path_lower: string;
  path_display: string;
  ".tag": 'file' | 'folder';
};

async function dropboxAccessToken(refreshToken: string, clientId?: string, clientSecret?: string) {
  const cid = clientId || process.env.DROPBOX_CLIENT_ID || '';
  const cs = clientSecret || process.env.DROPBOX_CLIENT_SECRET || '';
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cid,
    client_secret: cs,
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

async function dbxListFolder(access: string, path: string, recursive = false) {
  const body = JSON.stringify({ path, recursive });
  const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body,
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`dbx list: ${r.status} ${JSON.stringify(j)}`);
  let entries: DbxEntry[] = j.entries || [];
  // handle pagination (has_more)
  let cursor = j.cursor;
  while (j.has_more) {
    const r2 = await fetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor }),
    });
    const j2: any = await r2.json().catch(() => ({}));
    if (!r2.ok) throw new Error(`dbx continue: ${r2.status} ${JSON.stringify(j2)}`);
    entries = entries.concat(j2.entries || []);
    cursor = j2.cursor;
    j.has_more = j2.has_more;
  }
  return entries.filter((e) => e['.tag'] === 'file');
}

async function dbxSharedRawLink(access: string, filePath: string): Promise<string> {
  // Try to create a shared link, fallback to listing existing links
  const create = await fetch(
    'https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    }
  );
  const cj: any = await create.json().catch(() => ({}));
  if (create.ok && cj?.url) return String(cj.url).replace('?dl=0', '?raw=1');
  const summary = cj?.error_summary || '';
  if (!create.ok && summary.includes('shared_link_already_exists')) {
    const r2 = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, direct_only: true }),
    });
    const j2: any = await r2.json().catch(() => ({}));
    if (!r2.ok || !j2.links?.length) throw new Error(`dbx links: ${r2.status} ${JSON.stringify(j2)}`);
    return String(j2.links[0].url).replace('?dl=0', '?raw=1');
  }
  throw new Error(`dbx share: ${create.status} ${JSON.stringify(cj)}`);
}

function groupBySku(entries: DbxEntry[]) {
  const out: Record<string, { sku: string; files: DbxEntry[]; main?: DbxEntry; price?: DbxEntry }>
    = {};
  for (const e of entries) {
    const idx = e.name.indexOf('_');
    if (idx <= 0) continue; // skip files not matching xx_*
    const sku = e.name.slice(0, idx);
    const suffix = e.name.slice(idx + 1).toLowerCase();
    if (!out[sku]) out[sku] = { sku, files: [] };
    out[sku].files.push(e);
    if (suffix.startsWith('01')) out[sku].main = e;
    if (suffix.startsWith('price')) out[sku].price = e;
  }
  // Build structured groups
  const groups = Object.values(out).map((g) => {
    const others = g.files
      .filter((f) => f !== g.main && f !== g.price && /\.(jpe?g|png|webp|gif|bmp|tiff)$/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const main = g.main || others[0];
    return { sku: g.sku, main, others, price: g.price };
  });
  // Only include groups that have at least one image
  return groups.filter((g) => !!g.main);
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
    const recursive = /^1|true|yes$/i.test(String(qs.recursive || '0'));
    const useProxy = /^1|true|yes$/i.test(String(qs.useProxy || '1'));
    const skuFilter = (qs.sku || qs.skuPrefix || '') as string;
    const limit = Number(qs.limit || 0) || undefined;

    const store = tokensStore();
    const saved = (await store.get('dropbox.json', { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) return { statusCode: 400, body: 'Connect Dropbox first' };

    const access = await dropboxAccessToken(refresh);
    const files = await dbxListFolder(access, folder, recursive);
    const filtered = skuFilter
      ? files.filter((f) => f.name.startsWith(skuFilter + '_'))
      : files;
    const groups = groupBySku(filtered);

  const result: any[] = [];
  const derivedBase = deriveBaseUrlFromEvent(event);
    for (const g of groups.slice(0, limit || groups.length)) {
      // Create shared links
      const mainUrl = await dbxSharedRawLink(access, g.main!.path_lower);
      const otherUrls: string[] = [];
      for (const f of g.others) {
        otherUrls.push(await dbxSharedRawLink(access, f.path_lower));
      }
      const priceUrl = g.price ? await dbxSharedRawLink(access, g.price.path_lower) : undefined;
      const images = [mainUrl, ...otherUrls];
      const finalImages = useProxy ? images.map((u) => proxyUrl(u, derivedBase)) : images;
      result.push({
        sku: g.sku,
        folder,
        main: g.main?.path_display,
        images: finalImages,
        priceImage: useProxy && priceUrl ? proxyUrl(priceUrl, derivedBase) : priceUrl,
        raw: {
          main: mainUrl,
          others: otherUrls,
          price: priceUrl,
        },
      });
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, folder, count: result.length, useProxy, items: result }),
    };
  } catch (e: any) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e?.message || String(e) }),
    };
  }
};
