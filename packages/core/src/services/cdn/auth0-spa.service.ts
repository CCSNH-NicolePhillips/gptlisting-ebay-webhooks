/**
 * packages/core/src/services/cdn/auth0-spa.service.ts
 *
 * Proxy / serve the Auth0 SPA SDK with caching.
 * Route: GET /api/cdn/auth0-spa
 */

// ─── Error classes ────────────────────────────────────────────────────────────

export class Auth0SpaFetchError extends Error {
  readonly statusCode: number;
  constructor(msg: string, statusCode = 502) {
    super(msg); this.name = 'Auth0SpaFetchError'; this.statusCode = statusCode;
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Fetch the Auth0 SPA SDK from the canonical CDN and return the body + content-type.
 *
 * Query params:
 *  v   — SDK version (default: '2.0.3')
 *  esm — 'true' | '1' → use ESM build from unpkg.com
 */
export async function fetchAuth0SpaSdk(
  version = '2.0.3',
  esm = false,
): Promise<{ body: string; contentType: string }> {
  const safeVersion = version.replace(/[^0-9a-zA-Z.\-]/g, '');

  const url = esm
    ? `https://unpkg.com/@auth0/auth0-spa-js@${safeVersion}/dist/auth0-spa-js.production.esm.js`
    : `https://cdn.auth0.com/js/auth0-spa-js/${safeVersion}/auth0-spa-js.production.js`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (e: any) {
    throw new Auth0SpaFetchError(`Failed to fetch Auth0 SPA SDK: ${e.message}`);
  }

  if (!res.ok) {
    throw new Auth0SpaFetchError(
      `Auth0 CDN returned ${res.status} for version ${safeVersion}`,
      res.status,
    );
  }

  const body = await res.text();
  const contentType = res.headers.get('content-type') || 'application/javascript; charset=utf-8';

  return { body, contentType };
}
