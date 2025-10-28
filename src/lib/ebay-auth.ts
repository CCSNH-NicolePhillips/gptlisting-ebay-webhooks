import { accessTokenFromRefresh, tokenHosts } from "../../functions/_common.js";
import { tokensStore } from "../../functions/_blobs.js";
import { userScopedKey } from "../../functions/_auth.js";

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

  const { access_token } = await accessTokenFromRefresh(refreshToken);
  if (!access_token) {
    throw new Error("Failed to obtain eBay access token");
  }

  const { apiHost } = tokenHosts(process.env.EBAY_ENV);
  return { token: access_token, apiHost };
}
