import type { Handler } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

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
      redirect_uri: (process.env.EBAY_RUNAME || process.env.EBAY_RU_NAME)!,
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

    if (data.refresh_token) {
      const tokens = getStore("tokens");
      await tokens.setJSON("ebay.json", { refresh_token: data.refresh_token });
    }
    return { statusCode: 302, headers: { Location: "/" } };
  } catch (e: any) {
    return { statusCode: 500, body: `OAuth error: ${e.message}` };
  }
};
