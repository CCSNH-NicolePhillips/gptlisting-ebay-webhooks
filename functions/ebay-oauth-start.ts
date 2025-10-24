import type { Handler } from '@netlify/functions';
import { createOAuthStateForUser, getJwtSubUnverified, getBearerToken, requireAuthVerified, userScopedKey } from './_auth.js';
import { tokensStore } from './_blobs.js';

function sanitizeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let candidate = value.trim();
  if (!candidate) return null;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate);
      candidate = `${url.pathname || '/'}`;
      if (url.search) candidate += url.search;
      if (url.hash) candidate += url.hash;
    } catch {
      return null;
    }
  }
  if (!candidate.startsWith('/')) return null;
  return candidate;
}

export const handler: Handler = async (event) => {
  const clientId = process.env.EBAY_CLIENT_ID!;
  const runame = process.env.EBAY_RUNAME || process.env.EBAY_RU_NAME;
  if (!runame) return { statusCode: 500, body: 'Missing EBAY_RUNAME/EBAY_RU_NAME' };
  const env = process.env.EBAY_ENV || 'PROD';
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
  let parsedBody: any = null;
  if (event.body) {
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
      parsedBody = JSON.parse(raw);
    } catch {}
  }
  const queryReturnTo = sanitizeReturnTo(event.queryStringParameters?.returnTo);
  const bodyReturnTo = sanitizeReturnTo(parsedBody?.returnTo);
  const returnTo = bodyReturnTo || queryReturnTo || null;

  const stateRaw = (await createOAuthStateForUser(event, 'ebay', { returnTo })) ||
    Buffer.from(JSON.stringify({ t: Date.now() })).toString('base64');
  const state = encodeURIComponent(stateRaw);
  const host = env === 'SANDBOX' ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com';

  const scopes = [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.account',
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    'https://api.ebay.com/oauth/api_scope/sell.marketing',
    'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
  ].join(' ');

  let url =
    `${host}/oauth2/authorize?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(runame)}` +
    `&response_type=code&state=${state}&scope=${encodeURIComponent(scopes)}`;
  // Always request a fresh login to avoid reusing a prior eBay browser session for a different Auth0 user
  // eBay supports the standard OIDC "prompt" parameter; use login specifically (consent can be handled during flow)
  url += `&prompt=${encodeURIComponent('login')}`;
  const wantsJson = /application\/json/i.test(String(event.headers?.accept || '')) || event.queryStringParameters?.mode === 'json';
  if (wantsJson) {
    const jsonHeaders = { 'Content-Type': 'application/json' } as Record<string, string>;
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ redirect: url }) };
  }
  return { statusCode: 302, headers: { Location: url } };
};
