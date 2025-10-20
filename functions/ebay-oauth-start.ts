import type { Handler } from '@netlify/functions';

export const handler: Handler = async () => {
  const clientId = process.env.EBAY_CLIENT_ID!;
  const runame = process.env.EBAY_RUNAME || process.env.EBAY_RU_NAME;
  if (!runame) return { statusCode: 500, body: 'Missing EBAY_RUNAME/EBAY_RU_NAME' };
  const env = process.env.EBAY_ENV || 'PROD';
  const state = encodeURIComponent(
    Buffer.from(JSON.stringify({ t: Date.now() })).toString('base64')
  );
  const host = env === 'SANDBOX' ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com';

  const scopes = [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.account',
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    'https://api.ebay.com/oauth/api_scope/sell.marketing',
    'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
  ].join(' ');

  const url =
    `${host}/oauth2/authorize?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(runame)}` +
    `&response_type=code&state=${state}&scope=${encodeURIComponent(scopes)}`;

  return { statusCode: 302, headers: { Location: url } };
};
