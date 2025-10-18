import type { Handler } from "@netlify/functions";

// Start Dropbox OAuth 2.0 flow
export const handler: Handler = async () => {
  const clientId = process.env.DROPBOX_CLIENT_ID;
  const redirectUri = process.env.DROPBOX_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return { statusCode: 500, body: "Missing DROPBOX_CLIENT_ID or DROPBOX_REDIRECT_URI" };
  }

  const state = Buffer.from(JSON.stringify({ t: Date.now() })).toString("base64");
  const url = new URL("https://www.dropbox.com/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("token_access_type", "offline");
  url.searchParams.set("state", state);

  return { statusCode: 302, headers: { Location: url.toString() } };
}
