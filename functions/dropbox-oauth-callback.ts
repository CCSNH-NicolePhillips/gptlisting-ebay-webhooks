import type { Handler } from '@netlify/functions';
import { tokensStore } from './_blobs.js';
import { consumeOAuthState } from './_auth.js';

export const handler: Handler = async (event) => {
  try {
  const code = event.queryStringParameters?.code;
    if (!code) return { statusCode: 400, body: 'Missing ?code' };
  const state = event.queryStringParameters?.state || null;
  const sub = await consumeOAuthState(state || null);

    const clientId = process.env.DROPBOX_CLIENT_ID!;
    const clientSecret = process.env.DROPBOX_CLIENT_SECRET!;
    const redirectUri = process.env.DROPBOX_REDIRECT_URI!;

    const body = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });

    const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, body: `Dropbox token error: ${JSON.stringify(data)}` };
    }

    const refreshToken = data.refresh_token as string | undefined;
    if (!refreshToken) {
      return { statusCode: 400, body: 'No refresh_token returned' };
    }

  const tokens = tokensStore();
  const key = sub ? `users/${encodeURIComponent(sub)}/dropbox.json` : 'dropbox.json';
  await tokens.setJSON(key, { refresh_token: refreshToken });

    return { statusCode: 302, headers: { Location: '/' } };
  } catch (e: any) {
    return { statusCode: 500, body: `Dropbox OAuth error: ${e.message}` };
  }
};
