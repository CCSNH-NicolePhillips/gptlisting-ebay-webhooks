import { getStore } from "@netlify/blobs";

// Returns a Blobs store named "tokens".
// Uses Netlify's managed credentials by default.
// If not available (e.g., local or custom env), you can supply either
// NETLIFY_BLOBS_SITE_ID/TOKEN or BLOBS_SITE_ID/TOKEN env vars.
export function tokensStore() {
  const siteID =
    process.env.NETLIFY_BLOBS_SITE_ID || process.env.BLOBS_SITE_ID || undefined;
  const token =
    process.env.NETLIFY_BLOBS_TOKEN || process.env.BLOBS_TOKEN || undefined;
  if (siteID && token) {
    // Official object form with explicit credentials
    return getStore({ name: "tokens", siteID, token });
  }
  // Default: use Netlify-provisioned credentials in production
  return getStore("tokens");
}

// General cache store for large/shared data (e.g., taxonomy trees)
export function cacheStore() {
  const siteID =
    process.env.NETLIFY_BLOBS_SITE_ID || process.env.BLOBS_SITE_ID || undefined;
  const token =
    process.env.NETLIFY_BLOBS_TOKEN || process.env.BLOBS_TOKEN || undefined;
  if (siteID && token) {
    return getStore({ name: "cache", siteID, token });
  }
  return getStore("cache");
}
