import type { Handler } from '@netlify/functions';

// Proxies the Auth0 SPA JS SDK through same-origin so strict CSP (script-src 'self') still works.
// Usage: <script src="/.netlify/functions/cdn-auth0-spa?v=2.5"></script>
// Default version is 2.5. Adjust via ?v=2.1 etc.

export const handler: Handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};
    const v = (q.v || '2.5').trim();
    const esm = q.esm === '1' || q.esm === 'true';
    let url: string;
    if (esm) {
      const ver = /^[0-9]+(\.[0-9]+){0,2}$/.test(v) ? v : '2.5.0';
      url = `https://unpkg.com/@auth0/auth0-spa-js@${encodeURIComponent(ver)}/dist/auth0-spa-js.production.esm.js`;
    } else {
      const base = `https://cdn.auth0.com/js/auth0-spa-js/${encodeURIComponent(v)}`;
      url = `${base}/auth0-spa-js.production.js`;
    }

    const upstream = await fetch(url);
    const body = await upstream.text();
    if (!upstream.ok) {
      return {
        statusCode: upstream.status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        body: `Failed to fetch Auth0 SPA SDK: ${upstream.status} ${upstream.statusText}`,
      };
    }
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        // Cache at the edge and browser for a day; bump version to refresh.
        'Cache-Control': 'public, max-age=86400',
      },
      body,
    };
  } catch (e: any) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      body: `Proxy error: ${e.message || String(e)}`,
    };
  }
};
