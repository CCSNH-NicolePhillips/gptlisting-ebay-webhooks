/**
 * dropbox.ts — Express routes for Dropbox OAuth 2.0 connect flow and file access.
 *
 * Mounts under /api/dropbox  (registered in routes/index.ts)
 *
 * Endpoints:
 *   GET  /api/dropbox/oauth/start      ← /.netlify/functions/dropbox-oauth-start
 *   GET  /api/dropbox/oauth/callback   ← /.netlify/functions/dropbox-oauth-callback
 *   GET  /api/dropbox/files            ← dropbox-list-files.ts         (user)
 *   GET  /api/dropbox/folders          ← dropbox-list-folders.ts       (user)
 *   GET  /api/dropbox/images           ← dropbox-list-images.ts        (user)
 *   GET  /api/dropbox/grouped          ← dropbox-list-grouped.ts       (admin)
 *   POST /api/dropbox/thumbnails       ← dropbox-get-thumbnails.ts     (user)
 *   POST /api/dropbox/tree             ← dbx-list-tree-user.ts         (user)
 */

import { createHash } from 'crypto';
import { Router } from 'express';
import { requireUserAuth } from '../../../../src/lib/auth-user.js';
import { requireAdminAuth } from '../../../../src/lib/auth-admin.js';
import { serverError } from '../http/respond.js';
import { tokensStore } from '../../../../src/lib/redis-store.js';
import { userScopedKey } from '../../../../src/lib/_auth.js';
import {
  startDropboxOAuth,
  callbackDropboxOAuth,
  sanitizeReturnTo,
  DropboxOAuthConfigError,
  DropboxOAuthStateError,
  DropboxOAuthTokenError,
} from '../../../../packages/core/src/services/oauth/dropbox-oauth.service.js';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Shared Dropbox helper utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Exchange a Dropbox refresh token for a short-lived access token. */
async function dropboxAccessToken(refreshToken: string): Promise<string> {
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

/** Fetch user's Dropbox refresh token from Redis. Returns or throws. */
async function getDropboxRefreshToken(userId: string): Promise<string> {
  const store = tokensStore();
  const saved = (await store.get(userScopedKey(userId, 'dropbox.json'), { type: 'json' })) as any;
  const refresh = saved?.refresh_token as string | undefined;
  if (!refresh) throw Object.assign(new Error('Connect Dropbox first'), { code: 'dropbox-not-connected' });
  return refresh;
}

/** List a Dropbox folder, handling pagination. Returns ALL file entries. */
async function dbxListFolderFiles(access: string, path: string, recursive = false): Promise<any[]> {
  type DbxEntry = { '.tag': string; name: string; id: string; path_lower: string; path_display: string };
  const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, recursive }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`dbx list: ${r.status} ${JSON.stringify(j)}`);
  let entries: DbxEntry[] = j.entries || [];
  let cursor = j.cursor;
  let hasMore = j.has_more;
  while (hasMore) {
    const r2 = await fetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor }),
    });
    const j2: any = await r2.json().catch(() => ({}));
    if (!r2.ok) throw new Error(`dbx continue: ${r2.status} ${JSON.stringify(j2)}`);
    entries = entries.concat(j2.entries || []);
    cursor = j2.cursor;
    hasMore = j2.has_more;
  }
  return entries;
}

/** Create/retrieve a shared raw link for a Dropbox file path. */
async function dbxSharedRawLink(access: string, filePath: string): Promise<string> {
  function normalize(u: string) {
    try {
      const url = new URL(u);
      if (/\.dropbox\.com$/i.test(url.hostname)) url.hostname = 'dl.dropboxusercontent.com';
      url.searchParams.delete('dl');
      url.searchParams.set('raw', '1');
      return url.toString();
    } catch {
      return u.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace('?dl=0', '?raw=1').replace('&dl=0', '&raw=1');
    }
  }
  const create = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath }),
  });
  const cj: any = await create.json().catch(() => ({}));
  if (create.ok && cj?.url) return normalize(String(cj.url));
  if ((cj?.error_summary || '').includes('shared_link_already_exists')) {
    const r2 = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, direct_only: true }),
    });
    const j2: any = await r2.json().catch(() => ({}));
    if (!r2.ok || !j2.links?.length) throw new Error(`dbx links: ${r2.status} ${JSON.stringify(j2)}`);
    return normalize(String(j2.links[0].url));
  }
  throw new Error(`dbx share: ${create.status} ${JSON.stringify(cj)}`);
}

function isImage(name: string) {
  return /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(name);
}

/** Build image proxy URL (Express: /api/images/proxy?url=...). */
function proxyImgUrl(rawUrl: string, reqBase?: string): string {
  const base = process.env.APP_BASE_URL || reqBase || '';
  const encoded = encodeURIComponent(rawUrl);
  return base ? `${base}/api/images/proxy?url=${encoded}` : `/api/images/proxy?url=${encoded}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Popup-success HTML template
// ─────────────────────────────────────────────────────────────────────────────
function popupSuccessHtml(service: string, label: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>${label} Connected</title></head>
<body style="background:#0a0a1a;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
<div style="text-align:center;">
<h2 style="color:#4ade80;">&#10003; ${label} Connected!</h2>
<p>This window will close automatically...</p>
</div>
<script>
  if (window.opener) {
    try { window.opener.postMessage({ type: 'oauth-complete', service: '${service}', success: true }, '*'); } catch(e) {}
  }
  setTimeout(() => window.close(), 1500);
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth routes
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/dropbox/oauth/start
router.get('/oauth/start', async (req, res) => {
  const authHeader =
    req.headers.authorization ||
    (req.query.token ? `Bearer ${req.query.token}` : '');

  let userId: string;
  try {
    const user = await requireUserAuth(authHeader);
    userId = user.userId;
  } catch {
    const wantsJson =
      /application\/json/i.test(req.headers.accept || '') ||
      req.query.mode === 'json';
    if (wantsJson) return void res.status(401).json({ error: 'Unauthorized' });
    return void res.redirect('/login.html');
  }

  const returnTo = sanitizeReturnTo(req.query.returnTo);
  try {
    const { redirectUrl } = await startDropboxOAuth(userId, returnTo);
    const wantsJson =
      /application\/json/i.test(req.headers.accept || '') ||
      req.query.mode === 'json';
    if (wantsJson) return void res.json({ redirect: redirectUrl });
    return void res.redirect(redirectUrl);
  } catch (err) {
    if (err instanceof DropboxOAuthConfigError) return void res.status(500).json({ error: err.message });
    return void res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/dropbox/oauth/callback
router.get('/oauth/callback', async (req, res) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  if (!code) return void res.status(400).json({ error: 'Missing ?code' });
  if (!state) return void res.status(400).json({ error: 'Missing ?state' });

  try {
    const { returnTo, isPopup } = await callbackDropboxOAuth(code, state);
    if (isPopup) {
      return void res
        .set('Content-Type', 'text/html; charset=utf-8')
        .send(popupSuccessHtml('dropbox', 'Dropbox'));
    }
    return void res.redirect(returnTo || '/index.html');
  } catch (err) {
    if (err instanceof DropboxOAuthStateError) {
      return void res.status(400).json({ error: 'invalid_state', hint: 'Start Dropbox connect from the app while signed in' });
    }
    if (err instanceof DropboxOAuthTokenError) {
      return void res.status(err.statusCode).json({ error: err.message, detail: err.detail });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return void res.status(500).json({ error: `Dropbox OAuth error: ${msg}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// File listing routes
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/dropbox/files?path=  — list files (non-recursive)
router.get('/files', async (req, res) => {
  let userId: string;
  try {
    ({ userId } = await requireUserAuth(req.headers.authorization || ''));
  } catch {
    return void res.status(401).send('Unauthorized');
  }
  try {
    const path = (req.query.path as string) || '';
    const refresh = await getDropboxRefreshToken(userId);
    const access = await dropboxAccessToken(refresh);
    const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, recursive: false }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) return void res.status(r.status).json(j);
    const files = (j.entries || []).filter((e: any) => e['.tag'] === 'file');
    res.json({ ok: true, path, count: files.length, files });
  } catch (err: any) {
    if (err?.code === 'dropbox-not-connected') return void res.status(400).json({ error: err.message });
    serverError(res, err);
  }
});

// GET /api/dropbox/folders?path=&recursive=  — list folders
router.get('/folders', async (req, res) => {
  let userId: string;
  try {
    ({ userId } = await requireUserAuth(req.headers.authorization || ''));
  } catch {
    return void res.status(401).send('Unauthorized');
  }
  try {
    const path = (req.query.path as string) || (req.query.folder as string) || '';
    const recursive = /^1|true|yes$/i.test(String(req.query.recursive || '0'));
    const refresh = await getDropboxRefreshToken(userId);
    const access = await dropboxAccessToken(refresh);
    const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, recursive }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) return void res.status(r.status).json(j);
    const folders = (j.entries || []).filter((e: any) => e['.tag'] === 'folder');
    res.json({ ok: true, path, recursive, count: folders.length, folders });
  } catch (err: any) {
    if (err?.code === 'dropbox-not-connected') return void res.status(400).json({ error: err.message });
    serverError(res, err);
  }
});

// GET /api/dropbox/images?path=&limit=  — list images with shared links
router.get('/images', async (req, res) => {
  let userId: string;
  try {
    ({ userId } = await requireUserAuth(req.headers.authorization || ''));
  } catch {
    return void res.status(401).send('Unauthorized');
  }
  try {
    const folder = (req.query.path as string) || (req.query.folder as string) || '/EBAY';
    const recursive = /^1|true|yes$/i.test(String(req.query.recursive || '0'));
    const limit = Number(req.query.limit || 0) || undefined;
    const useProxy = !/^0|false|no$/i.test(String(req.query.useProxy || '1'));

    const refresh = await getDropboxRefreshToken(userId);
    const access = await dropboxAccessToken(refresh);
    const entries = await dbxListFolderFiles(access, folder, recursive);
    const images = entries.filter((e: any) => e['.tag'] === 'file' && isImage(e.name));

    const reqBase = `${req.protocol}://${req.get('host')}`;
    const items = [] as Array<{ name: string; path: string; url: string; proxiedUrl: string }>;
    for (const e of images.slice(0, limit || images.length)) {
      const raw = await dbxSharedRawLink(access, e.path_lower);
      items.push({ name: e.name, path: e.path_display, url: raw, proxiedUrl: proxyImgUrl(raw, reqBase) });
    }
    res.json({ ok: true, folder, count: items.length, useProxy, items });
  } catch (err: any) {
    if (err?.code === 'dropbox-not-connected') return void res.status(400).json({ error: err.message });
    serverError(res, err);
  }
});

// GET /api/dropbox/grouped?path=&sku=  — group files by SKU prefix (admin)
router.get('/grouped', async (req, res) => {
  try {
    requireAdminAuth(req.headers.authorization);
  } catch {
    return void res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const folder = (req.query.path as string) || (req.query.folder as string) || '/EBAY';
    const recursive = /^1|true|yes$/i.test(String(req.query.recursive || '0'));
    const useProxy = !/^0|false|no$/i.test(String(req.query.useProxy || '1'));
    const skuFilter = ((req.query.sku as string) || (req.query.skuPrefix as string) || '');
    const limit = Number(req.query.limit || 0) || undefined;

    // Admin grouped uses a global dropbox.json token (not user-scoped)
    const store = tokensStore();
    const saved = (await store.get('dropbox.json', { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) return void res.status(400).json({ error: 'Connect Dropbox first' });

    const access = await dropboxAccessToken(refresh);
    const files = await dbxListFolderFiles(access, folder, recursive);
    const filtered = skuFilter
      ? files.filter((f: any) => f.name.startsWith(skuFilter + '_'))
      : files;

    // Group by SKU prefix (name prefix before first '_')
    const out: Record<string, { sku: string; files: any[]; main?: any; price?: any }> = {};
    for (const e of filtered) {
      const idx = e.name.indexOf('_');
      if (idx <= 0) continue;
      const sku = e.name.slice(0, idx);
      const suffix = e.name.slice(idx + 1).toLowerCase();
      if (!out[sku]) out[sku] = { sku, files: [] };
      out[sku].files.push(e);
      if (suffix.startsWith('01')) out[sku].main = e;
      if (suffix.startsWith('price')) out[sku].price = e;
    }
    const groups = Object.values(out)
      .map((g) => ({ ...g, others: g.files.filter((f) => f !== g.main && f !== g.price && isImage(f.name)).sort((a, b) => a.name.localeCompare(b.name)) }))
      .filter((g) => !!g.main);

    const reqBase = `${req.protocol}://${req.get('host')}`;
    const result: any[] = [];
    for (const g of groups.slice(0, limit || groups.length)) {
      const mainUrl = await dbxSharedRawLink(access, g.main!.path_lower);
      const otherUrls: string[] = [];
      for (const f of g.others) otherUrls.push(await dbxSharedRawLink(access, f.path_lower));
      const priceUrl = g.price ? await dbxSharedRawLink(access, g.price.path_lower) : undefined;
      const images = [mainUrl, ...otherUrls];
      const finalImages = useProxy ? images.map((u) => proxyImgUrl(u, reqBase)) : images;
      result.push({
        sku: g.sku, folder, main: g.main?.path_display, images: finalImages,
        priceImage: useProxy && priceUrl ? proxyImgUrl(priceUrl, reqBase) : priceUrl,
        raw: { main: mainUrl, others: otherUrls, price: priceUrl },
      });
    }
    res.json({ ok: true, folder, count: result.length, useProxy, items: result });
  } catch (err) {
    serverError(res, err);
  }
});

// POST /api/dropbox/thumbnails  — get temporary links for an array of file paths (user)
router.post('/thumbnails', async (req, res) => {
  let userId: string;
  try {
    ({ userId } = await requireUserAuth(req.headers.authorization || ''));
  } catch {
    return void res.status(401).send('Unauthorized');
  }
  try {
    const body: any = req.body ?? {};
    const filePaths = body.files as string[] | undefined;
    if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
      return void res.status(400).json({ error: 'Missing or invalid files array' });
    }
    const refresh = await getDropboxRefreshToken(userId);
    const access = await dropboxAccessToken(refresh);
    const thumbnails = await Promise.all(
      filePaths.map(async (path) => {
        try {
          const r = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
            method: 'POST',
            headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
          });
          const j: any = await r.json().catch(() => ({}));
          if (!r.ok) return { path, link: null, error: j.error_summary };
          return { path, link: j.link };
        } catch (err) {
          return { path, link: null, error: String(err) };
        }
      }),
    );
    res.json({ ok: true, thumbnails });
  } catch (err: any) {
    if (err?.code === 'dropbox-not-connected') return void res.status(400).json({ error: err.message });
    serverError(res, err);
  }
});

// POST /api/dropbox/tree  — build grouped image tree from shared link or path (user)
router.post('/tree', async (req, res) => {
  let userId: string;
  try {
    ({ userId } = await requireUserAuth(req.headers.authorization || ''));
  } catch {
    return void res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    const body: any = req.body ?? {};
    const sharedLinkRaw = typeof body.sharedLink === 'string' ? body.sharedLink.trim() : '';
    const sharedLinkPassword = typeof body.sharedLinkPassword === 'string' && body.sharedLinkPassword.trim() ? body.sharedLinkPassword.trim() : undefined;
    const pathRaw = typeof body.path === 'string' ? body.path.trim() : '';
    if (!sharedLinkRaw && !pathRaw) {
      return void res.status(400).json({ ok: false, error: 'Provide sharedLink or path' });
    }

    const store = tokensStore();
    const saved = (await store.get(userScopedKey(userId, 'dropbox.json'), { type: 'json' })) as any;
    const refresh = typeof saved?.refresh_token === 'string' ? saved.refresh_token.trim() : '';
    if (!refresh) return void res.status(400).json({ ok: false, error: 'Connect Dropbox first' });
    const access = await dropboxAccessToken(refresh);

    type DbxEntry = { '.tag': string; id: string; name: string; path_lower?: string | null; path_display?: string | null };

    async function dropboxApi(url: string, bodyData?: unknown): Promise<any> {
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: bodyData ? JSON.stringify(bodyData) : undefined,
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`dropbox ${r.status}: ${text}`);
      return text ? JSON.parse(text) : {};
    }

    async function listFromSharedLink(link: string, password?: string): Promise<{ root: string; entries: DbxEntry[] }> {
      const meta = await dropboxApi('https://api.dropboxapi.com/2/sharing/get_shared_link_metadata', { url: link, ...(password ? { password } : {}) });
      const root = typeof meta?.path_lower === 'string' && meta.path_lower ? meta.path_lower : typeof meta?.name === 'string' ? meta.name : link;
      let entries: DbxEntry[] = [];
      let resp = await dropboxApi('https://api.dropboxapi.com/2/files/list_folder', {
        include_media_info: false, include_deleted: false, recursive: true, path: '',
        shared_link: password ? { url: link, password } : { url: link },
      });
      entries = entries.concat(resp?.entries || []);
      while (resp?.has_more) {
        resp = await dropboxApi('https://api.dropboxapi.com/2/files/list_folder/continue', { cursor: resp.cursor });
        entries = entries.concat(resp?.entries || []);
      }
      return { root, entries };
    }

    async function listFromPath(path: string): Promise<{ root: string; entries: DbxEntry[] }> {
      let entries: DbxEntry[] = [];
      let resp = await dropboxApi('https://api.dropboxapi.com/2/files/list_folder', { include_media_info: false, include_deleted: false, recursive: true, path: path || '' });
      entries = entries.concat(resp?.entries || []);
      while (resp?.has_more) {
        resp = await dropboxApi('https://api.dropboxapi.com/2/files/list_folder/continue', { cursor: resp.cursor });
        entries = entries.concat(resp?.entries || []);
      }
      return { root: path || '/', entries };
    }

    function folderPath(entry: DbxEntry) {
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
    function hashId(value: string) {
      return createHash('sha1').update(value).digest('hex').slice(0, 16);
    }

    async function buildGroups(entries: DbxEntry[]) {
      const files = entries.filter((e) => e['.tag'] === 'file' && isImage(e.name));
      const grouped = new Map<string, DbxEntry[]>();
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
        const links = await Promise.all(
          subset.map(async (entry) => {
            const path = entry.id || entry.path_lower || entry.path_display;
            if (!path) return null;
            try {
              const r = await dropboxApi('https://api.dropboxapi.com/2/files/get_temporary_link', { path });
              return typeof r?.link === 'string' && r.link ? r.link : null;
            } catch { return null; }
          }),
        );
        const images = links.filter((l): l is string => typeof l === 'string' && l.length > 0);
        if (!images.length) continue;
        const sample = bucket[0];
        const idSource = `${folder}|${sample.id || sample.path_lower || sample.path_display || sample.name}`;
        groups.push({ groupId: `grp_${hashId(idSource)}`, folder, name, images });
      }
      groups.sort((a, b) => a.folder.localeCompare(b.folder));
      return groups;
    }

    const listing = sharedLinkRaw
      ? await listFromSharedLink(sharedLinkRaw, sharedLinkPassword)
      : await listFromPath(pathRaw);
    const groups = await buildGroups(listing.entries);
    res.json({ ok: true, root: listing.root, groups });
  } catch (err: any) {
    const message = err?.message || String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

export default router;
