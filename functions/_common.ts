// Shared helpers for eBay OAuth in TS (uses global fetch in Node 18+)
export function tokenHosts(env: string | undefined) {
  const isSb = (env || 'PROD') === 'SANDBOX';
  const defaultApi = isSb ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
  const apiOverride = (process.env.EBAY_ENDPOINT_URL || '').trim();
  return {
    tokenHost: isSb ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com',
    apiHost: apiOverride || defaultApi,
  };
}

export async function accessTokenFromRefresh(refreshToken: string, scopes?: string[]) {
  const { tokenHost } = tokenHosts(process.env.EBAY_ENV);
  const basic = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: (scopes && scopes.length
      ? scopes
      : [
          'https://api.ebay.com/oauth/api_scope',
          'https://api.ebay.com/oauth/api_scope/sell.account',
          'https://api.ebay.com/oauth/api_scope/sell.inventory',
        ]
    ).join(' '),
  });

  const res = await fetch(`${tokenHost}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`token refresh failed: ${res.status} ${t}`);
  }
  return (await res.json()) as { access_token: string; expires_in: number };
}

export async function appAccessToken(scopes: string[]) {
  const { tokenHost } = tokenHosts(process.env.EBAY_ENV);
  const basic = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: scopes.join(' '),
  });
  const res = await fetch(`${tokenHost}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`app token failed: ${res.status} ${t}`);
  }
  return (await res.json()) as { access_token: string; expires_in: number };
}
