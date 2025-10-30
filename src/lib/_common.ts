// Shared helpers for eBay OAuth in TS (uses global fetch in Node 18+)

// Normalize environment values to canonical strings used for host selection
export function resolveEbayEnv(str?: string): 'production' | 'sandbox' {
  const v = String(str || '').trim().toLowerCase();
  if (['prod', 'production', 'live'].includes(v)) return 'production';
  if (['sb', 'sandbox', 'san'].includes(v)) return 'sandbox';
  // Default to production if unspecified or unrecognized
  return 'production';
}

export function tokenHosts(env: string | undefined) {
  const normalized = resolveEbayEnv(env);
  const isSb = normalized === 'sandbox';
  const defaultApi = isSb ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
  // Allow an explicit API host override, but only if it looks like an eBay host.
  // Some environments set EBAY_ENDPOINT_URL to the site origin; that should NOT be used here.
  const endpoint = (process.env.EBAY_ENDPOINT_URL || '').trim();
  const apiHostEnv = (process.env.EBAY_API_HOST || '').trim();
  let apiHost = defaultApi;
  if (apiHostEnv) {
    apiHost = apiHostEnv;
  } else if (endpoint) {
    try {
      const u = new URL(endpoint);
      const host = u.hostname.toLowerCase();
      if (host.includes('ebay.com')) {
        apiHost = `${u.protocol}//${u.host}`;
      }
    } catch {
      // Ignore invalid URL values
    }
  }
  return {
    tokenHost: isSb ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com',
    apiHost,
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
