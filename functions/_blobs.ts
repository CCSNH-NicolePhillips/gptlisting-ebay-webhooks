import { getStore } from "@netlify/blobs";

// Returns a Blobs store named "tokens". If running outside Netlify's
// managed environment (e.g., local dev without netlify dev), provide
// BLOBS_SITE_ID and BLOBS_TOKEN to configure access.
export function tokensStore() {
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  if (siteID && token) {
    // @ts-ignore: options shape is supported by @netlify/blobs at runtime
    return getStore("tokens", { siteID, token });
  }
  return getStore("tokens");
}
