import type { Handler } from '@netlify/functions';
import { createOAuthStateForUser, getJwtSubUnverified, getBearerToken, requireAuthVerified, userScopedKey } from './_auth.js';
import { tokensStore } from './_blobs.js';

// Start Dropbox OAuth 2.0 flow
export const handler: Handler = async (event) => {
  const clientId = process.env.DROPBOX_CLIENT_ID;
  const redirectUri = process.env.DROPBOX_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return { statusCode: 500, body: 'Missing DROPBOX_CLIENT_ID or DROPBOX_REDIRECT_URI' };
  }

  const bearer = getBearerToken(event);
  let sub = (await requireAuthVerified(event))?.sub || null;
  if (!sub) sub = getJwtSubUnverified(event);
  if (!bearer || !sub) {
    const wantsJson = /application\/json/i.test(String(event.headers?.accept || '')) || event.queryStringParameters?.mode === 'json';
    if (wantsJson) {
      const jsonHeaders = { 'Content-Type': 'application/json' } as Record<string, string>;
      return { statusCode: 401, headers: jsonHeaders, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
    return { statusCode: 302, headers: { Location: '/login.html' } };
  }

  // Bind this OAuth flow to the current user via opaque server-side state
  const userState = (await createOAuthStateForUser(event, 'dropbox')) ||
    Buffer.from(JSON.stringify({ t: Date.now() })).toString('base64');
  const url = new URL('https://www.dropbox.com/oauth2/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('token_access_type', 'offline');
  url.searchParams.set('state', userState);
  // If this user has never connected, force re-auth/consent to avoid reusing another Dropbox session silently
  try {
    const store = tokensStore();
    const existing = (await store.get(userScopedKey(sub, 'dropbox.json'), { type: 'json' })) as any;
    const firstConnect = !existing || !existing.refresh_token;
    if (firstConnect) {
      url.searchParams.set('force_reapprove', 'true');
      url.searchParams.set('force_reauthentication', 'true');
      url.searchParams.set('disable_signup', 'false');
    }
  } catch {}
  const wantsJson = /application\/json/i.test(String(event.headers?.accept || '')) || event.queryStringParameters?.mode === 'json';
  if (wantsJson) {
    const jsonHeaders = { 'Content-Type': 'application/json' } as Record<string, string>;
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ redirect: url.toString() }) };
  }
  return { statusCode: 302, headers: { Location: url.toString() } };
};
