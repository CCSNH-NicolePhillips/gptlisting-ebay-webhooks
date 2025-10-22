import type { Handler } from '@netlify/functions';
import { createOAuthStateForUser, getJwtSubUnverified, getBearerToken } from './_auth.js';

// Start Dropbox OAuth 2.0 flow
export const handler: Handler = async (event) => {
  const clientId = process.env.DROPBOX_CLIENT_ID;
  const redirectUri = process.env.DROPBOX_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return { statusCode: 500, body: 'Missing DROPBOX_CLIENT_ID or DROPBOX_REDIRECT_URI' };
  }

  const bearer = getBearerToken(event);
  const sub = getJwtSubUnverified(event);
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
  const wantsJson = /application\/json/i.test(String(event.headers?.accept || '')) || event.queryStringParameters?.mode === 'json';
  if (wantsJson) {
    const jsonHeaders = { 'Content-Type': 'application/json' } as Record<string, string>;
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ redirect: url.toString() }) };
  }
  return { statusCode: 302, headers: { Location: url.toString() } };
};
