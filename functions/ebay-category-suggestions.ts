import type { Handler } from "@netlify/functions";
import { tokenHosts, appAccessToken } from "./_common.js";

export const handler: Handler = async (event) => {
  try {
    const q = (event.queryStringParameters?.q || "").trim();
    if (!q) return { statusCode: 400, body: JSON.stringify({ error: "missing q" }) };
    const { access_token } = await appAccessToken([
      "https://api.ebay.com/oauth/api_scope/commerce.taxonomy.readonly",
    ]);
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
    const headers = {
      Authorization: `Bearer ${access_token}`,
      Accept: "application/json",
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
    } as Record<string, string>;

    // Find default tree for marketplace
    const treeUrl = `${apiHost}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE_ID}`;
    const tRes = await fetch(treeUrl, { headers });
    const tJson = await tRes.json();
    const treeId = tJson?.categoryTreeId;
    if (!treeId) return { statusCode: 500, body: JSON.stringify({ error: "no tree id", detail: tJson }) };

    // Suggestions for query
    const sugUrl = `${apiHost}/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions?q=${encodeURIComponent(q)}`;
    const sRes = await fetch(sugUrl, { headers });
    const sJson = await sRes.json();
    const cats = (sJson?.categorySuggestions || []).map((c: any) => ({
      categoryId: c.category?.categoryId,
      categoryName: c.category?.categoryName,
      categoryPath: (c.categoryTreeNodeAncestors || []).map((a: any) => a.categoryName).concat([c.category?.categoryName]).join(" > "),
      relevance: c.relevancy || c.relevancyScore || undefined,
    }));
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, treeId, suggestions: cats }) };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: "category-suggestions error", detail: e?.message || String(e) }) };
  }
};
