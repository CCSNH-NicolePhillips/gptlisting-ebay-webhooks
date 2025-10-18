import { cfg } from '../config.js';
import { fetch } from 'undici';
import fs from 'fs';
import path from 'path';

// ---- tiny file-store for demo (swap for DB/KMS in prod) ----
const TOKENS_FILE = path.join(cfg.dataDir, 'dropbox_tokens.json');
function readTokens(): Record<string, { refresh_token: string; scope?: string }> {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')) as any; } catch { return {}; }
}
function writeTokens(d: Record<string, any>) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(d, null, 2));
}

// ---- OAuth ----
export function oauthStartUrl() {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.dropbox.clientId,
    redirect_uri: cfg.dropbox.redirectUri,
    token_access_type: 'offline',
    scope: ['files.metadata.read','files.content.read','sharing.write'].join(' '),
    locale: process.env.DROPBOX_LOCALE || 'en_US'
  });
  return `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
}

export async function storeDropboxTokens(userId: string, code: string) {
  const form = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    client_id: cfg.dropbox.clientId,
    client_secret: cfg.dropbox.clientSecret,
    redirect_uri: cfg.dropbox.redirectUri
  });

  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString() // <- important: send string, not URLSearchParams object
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));

  const tokens = readTokens();
  tokens[userId] = { refresh_token: j.refresh_token, scope: j.scope };
  writeTokens(tokens);
  return j;
}

async function getAccessToken(userId: string): Promise<string> {
  const tokens = readTokens();
  const refresh_token = tokens[userId]?.refresh_token;
  if (!refresh_token) throw new Error('Dropbox not connected for user ' + userId);

  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token,
    client_id: cfg.dropbox.clientId,
    client_secret: cfg.dropbox.clientSecret
  });

  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));

  if (j.refresh_token) {
    const all = readTokens();
    all[userId].refresh_token = j.refresh_token;
    writeTokens(all);
  }
  return j.access_token as string;
}

// ---- Data ops ----
export async function listFolder(userId: string, folderPath: string) {
  const access = await getAccessToken(userId);
  const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${access}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ path: folderPath, recursive: false })
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j; // { entries: [...] }
}

export async function getRawLink(userId: string, filePath: string) {
  const access = await getAccessToken(userId);

  const create = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${access}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ path: filePath })
  });
  const cj: any = await create.json();

  if (!create.ok) {
    const summary: string = cj?.error_summary || '';
    if (summary.includes('shared_link_already_exists')) {
      const r2 = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path: filePath, direct_only: true })
      });
      const j2: any = await r2.json();
      if (!r2.ok || !j2.links?.length) throw new Error(JSON.stringify(j2));
      return (j2.links[0].url as string).replace('?dl=0','?raw=1');
    }
    throw new Error(JSON.stringify(cj));
  }

  return (cj.url as string).replace('?dl=0','?raw=1');
}
