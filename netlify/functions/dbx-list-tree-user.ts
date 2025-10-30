import type { Handler } from '@netlify/functions';
import { createHash } from 'crypto';
import { tokensStore } from '../../src/lib/_blobs.js';
import { userScopedKey } from '../../src/lib/_auth.js';
import { requireUserAuth } from '../../src/lib/auth-user.js';

type DropboxEntry = {
  '.tag': 'file' | 'folder';
  id: string;
  name: string;
  path_lower?: string | null;
  path_display?: string | null;
};

type ListResult = {
  root: string;
  entries: DropboxEntry[];
};

const CORS_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};

function jsonResponse(statusCode: number, payload: unknown) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS },
    body: JSON.stringify(payload),
  };
}

function isImage(name: string) {
  return /\.(jpe?g|png|gif|webp|tiff?|bmp)$/i.test(name);
}

function hashId(value: string) {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

async function dropboxAccessToken(refreshToken: string) {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: process.env.DROPBOX_CLIENT_ID || '',
    client_secret: process.env.DROPBOX_CLIENT_SECRET || '',
  });
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const text = await res.text();
  let json: any = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  if (!res.ok || !json?.access_token) {
    throw new Error(`dropbox token ${res.status}: ${text}`);
  }
  return String(json.access_token);
}

async function dropboxApi(token: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!text) {
    if (!res.ok) throw new Error(`dropbox ${res.status}`);
    return {};
  }
  try {
    const json = JSON.parse(text);
    if (!res.ok) throw new Error(`dropbox ${res.status}: ${text}`);
    return json;
  } catch {
    if (!res.ok) throw new Error(`dropbox ${res.status}: ${text}`);
    return {};
  }
}

async function listFromSharedLink(token: string, link: string, password?: string): Promise<ListResult> {
  const meta = await dropboxApi(token, 'https://api.dropboxapi.com/2/sharing/get_shared_link_metadata', {
    url: link,
    direct_only: false,
    ...(password ? { password } : {}),
  });
  const root = typeof meta?.path_lower === 'string' && meta.path_lower
    ? meta.path_lower
    : typeof meta?.name === 'string'
      ? meta.name
      : link;
  let entries: DropboxEntry[] = [];
  let resp = await dropboxApi(token, 'https://api.dropboxapi.com/2/files/list_folder', {
    include_media_info: false,
    include_deleted: false,
    recursive: true,
    path: '',
    shared_link: password ? { url: link, password } : { url: link },
  });
  entries = entries.concat((resp?.entries as DropboxEntry[]) || []);
  while (resp?.has_more) {
    resp = await dropboxApi(token, 'https://api.dropboxapi.com/2/files/list_folder/continue', {
      cursor: resp.cursor,
    });
    entries = entries.concat((resp?.entries as DropboxEntry[]) || []);
  }
  return { root, entries };
}

async function listFromPath(token: string, path: string): Promise<ListResult> {
  const cleaned = path || '';
  let entries: DropboxEntry[] = [];
  let resp = await dropboxApi(token, 'https://api.dropboxapi.com/2/files/list_folder', {
    include_media_info: false,
    include_deleted: false,
    recursive: true,
    path: cleaned,
  });
  entries = entries.concat((resp?.entries as DropboxEntry[]) || []);
  while (resp?.has_more) {
    resp = await dropboxApi(token, 'https://api.dropboxapi.com/2/files/list_folder/continue', {
      cursor: resp.cursor,
    });
    entries = entries.concat((resp?.entries as DropboxEntry[]) || []);
  }
  return { root: cleaned || '/', entries };
}

function folderPath(entry: DropboxEntry) {
  const raw = entry.path_display || entry.path_lower || '';
  if (!raw) return '';
  const parts = raw.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function leafName(folder: string) {
  if (!folder) return '(root)';
  const parts = folder.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '(root)';
}

async function temporaryLink(token: string, entry: DropboxEntry): Promise<string | null> {
  const path = entry.id || entry.path_lower || entry.path_display;
  if (!path) return null;
  try {
    const res = await dropboxApi(token, 'https://api.dropboxapi.com/2/files/get_temporary_link', {
      path,
    });
    if (typeof res?.link === 'string' && res.link) {
      return res.link;
    }
  } catch (err) {
    console.warn('[dbx-list-tree-user] temp link failed', err);
  }
  return null;
}

async function buildGroups(entries: DropboxEntry[], token: string) {
  const files = entries.filter((entry) => entry['.tag'] === 'file' && isImage(entry.name));
  const grouped = new Map<string, DropboxEntry[]>();
  for (const entry of files) {
    const folder = folderPath(entry);
    const key = folder || '__root__';
    const bucket = grouped.get(key) || [];
    bucket.push(entry);
    grouped.set(key, bucket);
  }
  const groups: Array<{ groupId: string; folder: string; name: string; images: string[] }> = [];
  for (const [key, bucket] of grouped.entries()) {
    const folder = key === '__root__' ? '' : key;
    const name = leafName(folder);
    const subset = bucket.slice(0, 12);
    const links = await Promise.all(subset.map((entry) => temporaryLink(token, entry)));
    const images = links.filter((link): link is string => typeof link === 'string' && link.length > 0);
    if (!images.length) continue;
    const sample = bucket[0];
    const idSource = `${folder}|${sample.id || sample.path_lower || sample.path_display || sample.name}`;
    groups.push({
      groupId: `grp_${hashId(idSource)}`,
      folder,
      name,
      images,
    });
  }
  groups.sort((a, b) => a.folder.localeCompare(b.folder));
  return groups;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: { ...CORS_HEADERS },
    };
  }
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method not allowed' });
  }

  try {
    const headerAuth = (event.headers.authorization || event.headers.Authorization || '') as string;
    let userId: string;
    try {
      const auth = await requireUserAuth(headerAuth);
      userId = auth.userId;
    } catch (err) {
      return jsonResponse(401, { ok: false, error: 'Unauthorized' });
    }

    const contentType = String(event.headers['content-type'] || event.headers['Content-Type'] || '');
    if (!contentType.toLowerCase().includes('application/json')) {
      return jsonResponse(415, { ok: false, error: 'Use application/json' });
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const sharedLinkRaw = typeof body.sharedLink === 'string' ? body.sharedLink.trim() : '';
    const sharedLinkPassword = typeof body.sharedLinkPassword === 'string' && body.sharedLinkPassword.trim()
      ? body.sharedLinkPassword.trim()
      : undefined;
    const pathRaw = typeof body.path === 'string' ? body.path.trim() : '';

    if (!sharedLinkRaw && !pathRaw) {
      return jsonResponse(400, { ok: false, error: 'Provide sharedLink or path' });
    }

    const store = tokensStore();
    const saved = (await store.get(userScopedKey(userId, 'dropbox.json'), { type: 'json' })) as any;
    const refresh = typeof saved?.refresh_token === 'string' ? saved.refresh_token.trim() : '';
    if (!refresh) {
      return jsonResponse(400, { ok: false, error: 'Connect Dropbox first' });
    }

    const access = await dropboxAccessToken(refresh);

    const listing = sharedLinkRaw
      ? await listFromSharedLink(access, sharedLinkRaw, sharedLinkPassword)
      : await listFromPath(access, pathRaw);

    const groups = await buildGroups(listing.entries, access);

    return jsonResponse(200, { ok: true, root: listing.root, groups });
  } catch (err: any) {
    const message = err?.message || String(err);
    return jsonResponse(500, { ok: false, error: message });
  }
};
