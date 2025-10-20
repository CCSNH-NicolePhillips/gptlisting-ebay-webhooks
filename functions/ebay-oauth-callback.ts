import type { Handler } from '@netlify/functions';
import { tokensStore } from './_blobs.js';

export const handler: Handler = async (event) => {
  try {
    const code = event.queryStringParameters?.code;
    if (!code) return { statusCode: 400, body: 'Missing ?code' };

    const env = process.env.EBAY_ENV || 'PROD';
    const tokenHost = env === 'SANDBOX' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
    const basic = Buffer.from(
      `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
    ).toString('base64');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: (process.env.EBAY_RUNAME || process.env.EBAY_RU_NAME)!,
    });

    const res = await fetch(`${tokenHost}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const text = await res.text();
    let data: any = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      console.error('eBay token exchange failed', {
        status: res.status,
        env,
        tokenHost,
        has_error: !!data.error || !!data.error_description,
        data,
      });
      const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' } as Record<
        string,
        string
      >;
      return {
        statusCode: 400,
        headers: jsonHeaders,
        body: JSON.stringify({
          error: 'eBay token error',
          status: res.status,
          detail: data,
          hint: "Ensure EBAY_ENV=PROD matches your RUName (Production) and the RUName's redirect URL points to /.netlify/functions/ebay-oauth-callback",
        }),
      };
    }

    console.log('OAuth tokens:', {
      has_refresh: !!data.refresh_token,
      has_access: !!data.access_token,
    });

    if (!data.refresh_token) {
      // Surface a helpful error so we can correct ENV/RUName/scopes
      const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' } as Record<
        string,
        string
      >;
      return {
        statusCode: 400,
        headers: jsonHeaders,
        body: JSON.stringify({
          error: 'No refresh_token returned',
          hint: 'Confirm EBAY_RUNAME is Production RUName with redirect to /.netlify/functions/ebay-oauth-callback, EBAY_ENV=PROD, and scopes include sell.account and sell.inventory',
          data,
        }),
      };
    }

    const tokens = tokensStore();
    await tokens.setJSON('ebay.json', { refresh_token: data.refresh_token });
    const redirectHeaders = { Location: '/' } as Record<string, string>;
    return { statusCode: 302, headers: redirectHeaders };
  } catch (e: any) {
    return { statusCode: 500, body: `OAuth error: ${e.message}` };
  }
};
