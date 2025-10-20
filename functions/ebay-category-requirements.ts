import type { Handler } from "@netlify/functions";
import { tokenHosts, appAccessToken, accessTokenFromRefresh } from "./_common.js";
import { tokensStore } from "./_blobs.js";

type Json = Record<string, any>;

function tryJson(t: string) { try { return JSON.parse(t); } catch { return t as any; } }

async function fetchJSON(url: string, headers: Record<string, string>) {
  let r = await fetch(url, { headers });
  if (r.status >= 500) { await new Promise(res => setTimeout(res, 400)); r = await fetch(url, { headers }); }
  const text = await r.text();
  const body = tryJson(text);
  return { ok: r.ok, status: r.status, body, text };
}

export const handler: Handler = async (event) => {
  try {
    const categoryId = event.queryStringParameters?.categoryId?.trim();
    if (!categoryId) return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "missing categoryId" }) };
    const qTreeId = (event.queryStringParameters?.treeId || "").trim();
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";

    const makeHeaders = (token: string) => ({
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
    } as Record<string, string>);

    // Acquire app token (taxonomy readonly) for taxonomy endpoints
    const appTok = await appAccessToken(["https://api.ebay.com/oauth/api_scope/commerce.taxonomy.readonly"]);
    const headersApp = makeHeaders(appTok.access_token);

    // Resolve treeId (non-fatal)
    let treeId = qTreeId;
    if (!treeId) {
      const tidUrl = `${apiHost}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE_ID}`;
      const tid = await fetchJSON(tidUrl, headersApp);
      if (tid.ok && tid.body?.categoryTreeId) treeId = String(tid.body.categoryTreeId);
      else treeId = "0"; // fallback; taxonomy call may still succeed or return helpful error
    }

    // Quick leaf check (optional): if subtree exists and has children, return a friendly error
    try {
      const subUrl = `${apiHost}/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_category_subtree?category_id=${encodeURIComponent(categoryId)}`;
      const sub = await fetchJSON(subUrl, headersApp);
      if (sub.ok) {
        const node = (sub.body?.categorySubtreeNode || sub.body?.categoryTreeNode || {}) as any;
        const kids = Array.isArray(node.childCategoryTreeNodes) ? node.childCategoryTreeNodes.length : 0;
        if (kids > 0) {
          return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "category-not-leaf", message: "Please select a leaf category (no subcategories). Use Browse to drill down.", detail: { treeId, categoryId } }) };
        }
      }
      // If 404 or non-ok, ignore; some trees don’t expose subtree for leaves
    } catch {}

    // Fetch taxonomy aspects with app token; fallback to user token on failures
    const aspectsUrl = `${apiHost}/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`;
    let aspects = await fetchJSON(aspectsUrl, headersApp);
    if (!aspects.ok) {
      const errStr = JSON.stringify(aspects.body) || aspects.text || "";
      const needsUser = /invalid_scope|401|403|502|503/.test(errStr) || aspects.status >= 500;
      if (needsUser) {
        try {
          const store = tokensStore();
          const saved = (await store.get("ebay.json", { type: "json" })) as any;
          const refresh = saved?.refresh_token as string | undefined;
          if (refresh) {
            const { access_token } = await accessTokenFromRefresh(refresh);
            const headersUser = makeHeaders(access_token);
            aspects = await fetchJSON(aspectsUrl, headersUser);
          }
        } catch (e) { /* fall through */ }
      }
    }

    if (!aspects.ok) {
      return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "category-requirements error", status: aspects.status, detail: aspects.body || aspects.text || "unknown", hint: "If you typed the category name, pick a leaf via Browse." }) };
    }

    const src = aspects.body as Json;
    const aspectArr = Array.isArray(src?.aspects) ? src.aspects : [];
    const mapped = aspectArr.map((a: any) => ({
      localizedAspectName: a.localizedAspectName,
      aspectName: a.aspectName,
      aspectValues: Array.isArray(a.aspectValues) ? a.aspectValues.map((v: any) => ({ localizedValue: v.localizedValue || v.value || v })) : [],
      aspectConstraint: a.aspectConstraint || {},
    }));

    const allowedConditions = (src?.itemConditionGroup?.itemConditions || []).map((c: any) => ({ conditionId: c.conditionId, conditionDescription: c.conditionDescription }));
    const requiredAspects = mapped.filter((a: any) => a.aspectConstraint?.itemToAspectCardinality === 'SINGLE' && a.aspectConstraint?.aspectRequired);
    const optionalAspects = mapped.filter((a: any) => !a.aspectConstraint?.aspectRequired);

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, marketplaceId: MARKETPLACE_ID, categoryId, treeId, allowedConditions, requiredAspects, optionalAspects, raw: { taxonomy: src } }) };
  } catch (e: any) {
    const detail = e?.message || String(e);
    console.error('category-requirements fatal:', detail);
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "category-requirements fatal", detail }) };
  }
};
