import type { Handler } from "@netlify/functions";
import { tokenHosts, appAccessToken } from "./_common.js";

export const handler: Handler = async () => {
  try {
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const { access_token } = await appAccessToken(["https://api.ebay.com/oauth/api_scope"]);
    const r = await fetch(`${apiHost}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE_ID}`, { headers: { Authorization: `Bearer ${access_token}` } });
    const text = await r.text();
    return { statusCode: r.status, headers: { "Content-Type": "application/json" }, body: text };
  } catch (e: any) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "tree-id error", detail: e?.message || String(e) }) };
  }
};
