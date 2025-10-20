import type { Handler } from "@netlify/functions";
import { tokenHosts, appAccessToken, accessTokenFromRefresh } from "./_common.js";
import { tokensStore } from "./_blobs.js";

type Json = Record<string, any>;

function tryJson(t: string) { try { return JSON.parse(t); } catch { return t as any; } }

async function fetchJsonPass(url: string, headers: Record<string, string>) {
  let r = await fetch(url, { headers });
  if (r.status >= 500) { await new Promise(res => setTimeout(res, 400)); r = await fetch(url, { headers }); }
  const text = await r.text();
  const body = tryJson(text);
  return { ok: r.ok, status: r.status, body, text };
}

async function getUserAccessToken(): Promise<string | null> {
  try {
    const store = tokensStore();
    const saved = (await store.get("ebay.json", { type: "json" })) as Json | null;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) return null;
    const { access_token } = await accessTokenFromRefresh(refresh);
    return access_token;
  } catch { return null; }
}

export const handler: Handler = async (event) => {
  const categoryId = event.queryStringParameters?.categoryId?.trim();
  let treeId = event.queryStringParameters?.treeId?.trim() || "";
  if (!categoryId) {
    return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "missing categoryId" }) };
  }

  const ENV = process.env.EBAY_ENV || "PROD";
  const { apiHost } = tokenHosts(ENV);
  const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";

  const headersFor = (token: string) => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Accept-Language": "en-US",
    "Content-Language": "en-US",
    "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
  } as Record<string, string>);

  // 1) App token with safe scope fallback
  let appTok: string | null = null;
  try {
    const t = await appAccessToken(["https://api.ebay.com/oauth/api_scope/commerce.taxonomy.readonly"]);
    appTok = t.access_token;
  } catch {
    const t2 = await appAccessToken(["https://api.ebay.com/oauth/api_scope"]);
    appTok = t2.access_token;
  }
  const appH = headersFor(appTok!);

  // 2) Resolve treeId; if app fails, try user token before defaulting to "0"
  if (!treeId) {
    const treeUrl = `${apiHost}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE_ID}`;
    let tree = await fetchJsonPass(treeUrl, appH);
    if (!tree.ok) {
      const userTok = await getUserAccessToken();
      if (userTok) tree = await fetchJsonPass(treeUrl, headersFor(userTok));
    }
    if (tree.ok && tree.body?.categoryTreeId) treeId = String(tree.body.categoryTreeId);
    else treeId = "0";
  }

  // helper to try app, then user token, pass-through status/body
  async function callTaxonomy(path: string) {
    const url = `${apiHost}${path}`;
    let res = await fetchJsonPass(url, appH);
    const bodyStr = JSON.stringify(res.body) || res.text || "";
    if (!res.ok && (/invalid_scope|401|403|502|503/i.test(bodyStr) || res.status >= 500)) {
      const userTok = await getUserAccessToken();
      if (userTok) res = await fetchJsonPass(url, headersFor(userTok));
    }
    return res;
  }

  // 3) Leaf check (non-fatal 400 if not leaf)
  const sub = await callTaxonomy(`/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_category_subtree?category_id=${encodeURIComponent(categoryId)}`);
  if (sub.ok) {
    const node = (sub.body?.categorySubtreeNode || sub.body?.categoryTreeNode || {}) as any;
    const kids = Array.isArray(node.childCategoryTreeNodes) ? node.childCategoryTreeNodes.length : 0;
    if (kids > 0) {
      return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "category-not-leaf", message: "Select a leaf category (no subcategories). Use Browse.", detail: { treeId, categoryId } }) };
    }
  }

  // 4) Get item aspects
  const aspects = await callTaxonomy(`/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`);
  if (!aspects.ok) {
    return { statusCode: aspects.status, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "category-requirements error", status: aspects.status, detail: aspects.body || aspects.text || "unknown" }) };
  }

  // 5) Map aspects (required may be SINGLE or MULTI)
  const src = aspects.body as Json;
  const arr = Array.isArray(src?.aspects) ? src.aspects : [];
  const mapped = arr.map((a: any) => ({
    name: a.localizedAspectName || a.aspectName,
    required: !!a.aspectConstraint?.aspectRequired,
    usage: a.aspectConstraint?.aspectUsage,
    dataType: a.aspectConstraint?.aspectDataType,
    multi: a.aspectConstraint?.itemToAspectCardinality === "MULTI",
    forVariations: !!a.aspectConstraint?.aspectEnabledForVariations,
    values: Array.isArray(a.aspectValues) ? a.aspectValues.map((v: any) => v.localizedValue ?? v.value ?? v) : [],
  }));
  const conditions = src?.itemConditionGroup?.itemConditions || [];

  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, marketplaceId: MARKETPLACE_ID, treeId, categoryId, allowedConditions: conditions, requiredAspects: mapped.filter(x => x.required), optionalAspects: mapped.filter(x => !x.required) }) };
};
