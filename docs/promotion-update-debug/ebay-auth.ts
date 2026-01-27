import { accessTokenFromRefresh, tokenHosts } from "./_common.js";
import { tokensStore } from "./redis-store.js";
import { userScopedKey } from "./_auth.js";

export type EbayAccessToken = {
  token: string;
  apiHost: string;
};

export async function getEbayAccessToken(userId?: string): Promise<EbayAccessToken> {
  let refreshToken = (process.env.EBAY_REFRESH_TOKEN || "").trim();

  // Prefer per-user stored token if userId provided
  if (userId) {
    try {
      const store = tokensStore();
      const saved = (await store.get(userScopedKey(userId, "ebay.json"), { type: "json" })) as any;
      const candidate = typeof saved?.refresh_token === "string" ? saved.refresh_token.trim() : "";
      if (candidate) refreshToken = candidate;
    } catch {
      // fall through to env/global
    }
  }

  // Global blob fallback
  if (!refreshToken) {
    try {
      const store = tokensStore();
      const saved = (await store.get("ebay.json", { type: "json" })) as any;
      const candidate = typeof saved?.refresh_token === "string" ? saved.refresh_token.trim() : "";
      if (candidate) refreshToken = candidate;
    } catch {
      // ignore
    }
  }

  if (!refreshToken) {
    throw new Error("EBAY_REFRESH_TOKEN env var is required or connect eBay for this user");
  }

  // Request token with marketing scope for Marketing API calls
  const { access_token } = await accessTokenFromRefresh(refreshToken, [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.account',
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    'https://api.ebay.com/oauth/api_scope/sell.marketing',
  ]);
  if (!access_token) {
    throw new Error("Failed to obtain eBay access token");
  }

  const { apiHost } = tokenHosts(process.env.EBAY_ENV);
  return { token: access_token, apiHost };
}

// Strict variant: when userId is provided, require a per-user refresh token and do NOT silently fall back
// to a global token. In admin mode (no userId), use the global env/blob token as before.
export async function getEbayAccessTokenStrict(userId?: string): Promise<EbayAccessToken> {
  if (userId) {
    // Require per-user token
    try {
      const store = tokensStore();
      const saved = (await store.get(userScopedKey(userId, "ebay.json"), { type: "json" })) as any;
      const refreshToken = typeof saved?.refresh_token === "string" ? saved.refresh_token.trim() : "";
      if (!refreshToken) throw new Error("No eBay token for this user. Connect eBay in Setup.");
      const { access_token } = await accessTokenFromRefresh(refreshToken, [
        'https://api.ebay.com/oauth/api_scope',
        'https://api.ebay.com/oauth/api_scope/sell.account',
        'https://api.ebay.com/oauth/api_scope/sell.inventory',
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
        'https://api.ebay.com/oauth/api_scope/sell.marketing',
      ]);
      const { apiHost } = tokenHosts(process.env.EBAY_ENV);
      return { token: access_token, apiHost };
    } catch (e: any) {
      const msg = e?.message || String(e ?? "");
      throw new Error(msg || "No eBay token for this user. Connect eBay in Setup.");
    }
  }
  // Admin/global mode
  let refreshToken = (process.env.EBAY_REFRESH_TOKEN || "").trim();
  if (!refreshToken) {
    try {
      const store = tokensStore();
      const saved = (await store.get("ebay.json", { type: "json" })) as any;
      const candidate = typeof saved?.refresh_token === "string" ? saved.refresh_token.trim() : "";
      if (candidate) refreshToken = candidate;
    } catch {
      // ignore
    }
  }
  if (!refreshToken) throw new Error("EBAY_REFRESH_TOKEN env var is required");
  const { access_token } = await accessTokenFromRefresh(refreshToken, [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.account',
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    'https://api.ebay.com/oauth/api_scope/sell.marketing',
  ]);
  const { apiHost } = tokenHosts(process.env.EBAY_ENV);
  return { token: access_token, apiHost };
}
