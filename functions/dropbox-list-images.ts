import type { Handler } from '@netlify/functions';
import { tokensStore } from './_blobs.js';
import { getJwtSubUnverified, userScopedKey, getBearerToken } from './_auth.js';

type DbxEntry = {
  name: string;
  id: string;
  path_lower: string;
  path_display: string;
  ".tag": 'file' | 'folder';
};

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

async function dbxListFolder(access: string, path: string, recursive = false) {
  const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, recursive }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`dbx list: ${r.status} ${JSON.stringify(j)}`);
  let entries: DbxEntry[] = j.entries || [];
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
  function normalize(u: string) {
    try {
      const url = new URL(u);
      // Force direct host for Dropbox
      if (/\.dropbox\.com$/i.test(url.hostname)) {
        url.hostname = 'dl.dropboxusercontent.com';
      }
      // Remove dl param, set raw=1, preserve rlkey and others
      url.searchParams.delete('dl');
      url.searchParams.set('raw', '1');
      return url.toString();
    } catch {
      // Fallback: simple replacements
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

function isImage(name: string) {
  return /\.(jpe?g|png|webp|gif|bmp|tiff)$/i.test(name);
}

export const handler: Handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const folder = (qs.path || qs.folder || '/EBAY') as string;
    const recursive = /^1|true|yes$/i.test(String(qs.recursive || '0'));
    const limit = Number(qs.limit || 0) || undefined;
    const useProxy = /^1|true|yes$/i.test(String(qs.useProxy || '1'));

  const store = tokensStore();
  const bearer = getBearerToken(event);
  const sub = getJwtSubUnverified(event);
  if (!bearer || !sub) return { statusCode: 401, body: 'Unauthorized' };
  const saved = (await store.get(userScopedKey(sub, 'dropbox.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) return { statusCode: 400, body: 'Connect Dropbox first' };

    const access = await dropboxAccessToken(refresh);
    const entries = await dbxListFolder(access, folder, recursive);
    const images = entries.filter((e) => isImage(e.name));

    const derivedBase = deriveBaseUrlFromEvent(event);
    const items = [] as Array<{ name: string; path: string; url: string; proxiedUrl: string }>; 
    for (const e of images.slice(0, limit || images.length)) {
      const raw = await dbxSharedRawLink(access, e.path_lower);
      const prox = proxyUrl(raw, derivedBase);
      items.push({ name: e.name, path: e.path_display, url: raw, proxiedUrl: prox });
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, folder, count: items.length, useProxy, items }),
    };
  } catch (e: any) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e?.message || String(e) }),
    };
  }
};
