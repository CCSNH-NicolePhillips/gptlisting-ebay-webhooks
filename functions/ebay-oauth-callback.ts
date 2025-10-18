import type { Handler } from "@netlify/functions";

export const handler: Handler = async (event) => {
  try {
    const code = event.queryStringParameters?.code;
    if (!code) return { statusCode: 400, body: "Missing ?code" };

    const env = process.env.EBAY_ENV || "PROD";
    const tokenHost = env === "SANDBOX" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
    const basic = Buffer.from(
      `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
    ).toString("base64");

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.EBAY_RUNAME!,
    });

    const res = await fetch(`${tokenHost}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const data = (await res.json()) as any;
    console.log("OAuth tokens:", {
      has_refresh: !!data.refresh_token,
      has_access: !!data.access_token,
    });

    // TODO: persist refresh_token per user (Netlify Blobs/DB)
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        note: "Store refresh_token server-side for this user",
        expires_in: data.expires_in,
      }),
    };
  } catch (e: any) {
    return { statusCode: 500, body: `OAuth error: ${e.message}` };
  }
};
