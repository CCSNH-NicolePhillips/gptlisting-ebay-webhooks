import type { Handler } from '@netlify/functions';

// Expose minimal public auth config to the frontend
// Configure via environment variables in Netlify:
// - AUTH_MODE: 'auth0' or 'identity'
// - AUTH0_DOMAIN
// - AUTH0_CLIENT_ID
// - AUTH0_AUDIENCE (optional)
// For Netlify Identity, set AUTH_MODE=identity and enable Identity in site settings.

export const handler: Handler = async () => {
  const rawMode = (process.env.AUTH_MODE || 'none').toLowerCase();
  const hasAuth0 = Boolean(process.env.AUTH0_DOMAIN && process.env.AUTH0_CLIENT_ID);
  // Normalize hybrid deployments that still rely on Auth0 credentials so the
  // frontend knows to load the SPA SDK.
  const resolvedMode = hasAuth0 && ['admin', 'user', 'mixed'].includes(rawMode) ? 'auth0' : rawMode;

  const body: Record<string, string> = { AUTH_MODE: resolvedMode };
  if (rawMode !== resolvedMode) body.AUTH_MODE_RAW = rawMode;
  if (resolvedMode === 'auth0') {
    if (process.env.AUTH0_DOMAIN) body.AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
    if (process.env.AUTH0_CLIENT_ID) body.AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID;
    if (process.env.AUTH0_AUDIENCE) body.AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE as string;
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
};
