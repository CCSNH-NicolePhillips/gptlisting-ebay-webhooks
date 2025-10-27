import { accessTokenFromRefresh, tokenHosts } from "../../functions/_common.js";

export type EbayAccessToken = {
  token: string;
  apiHost: string;
};

export async function getEbayAccessToken(): Promise<EbayAccessToken> {
  const refreshToken = (process.env.EBAY_REFRESH_TOKEN || "").trim();
  if (!refreshToken) {
    throw new Error("EBAY_REFRESH_TOKEN env var is required");
  }

  const { access_token } = await accessTokenFromRefresh(refreshToken);
  if (!access_token) {
    throw new Error("Failed to obtain eBay access token");
  }

  const { apiHost } = tokenHosts(process.env.EBAY_ENV);
  return { token: access_token, apiHost };
}
