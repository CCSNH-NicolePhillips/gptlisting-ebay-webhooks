import type { Handler } from "@netlify/functions";
import { tokenHosts, appAccessToken } from "./_common.js";

export const handler: Handler = async (event) => {
  try {
    const categoryId = event.queryStringParameters?.categoryId;
    if (!categoryId) return { statusCode: 400, body: JSON.stringify({ error: "Missing categoryId" }) };
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const { access_token } = await appAccessToken(["https://api.ebay.com/oauth/api_scope"]);

    async function getTreeId(): Promise<string> {
      const r = await fetch(`${apiHost}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE_ID}`, { headers: { Authorization: `Bearer ${access_token}` } });
      const j = await r.json();
      const tid = j?.categoryTreeId; if (!tid) throw new Error('No treeId');
      return String(tid);
    }
    const treeId = (event.queryStringParameters?.treeId || await getTreeId()) as string;

    const url = `${apiHost}/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
    const json = await r.json();
    const aspects = (json?.aspects || []).map((a: any) => ({
      name: a.localizedAspectName || a.aspectName,
      required: !!a.aspectConstraint?.aspectRequired,
      usage: a.aspectConstraint?.aspectUsage,
      dataType: a.aspectConstraint?.aspectDataType,
      multi: a.aspectConstraint?.itemToAspectCardinality === "MULTI",
      forVariations: !!a.aspectConstraint?.aspectEnabledForVariations,
      values: (a.aspectValues || []).map((v: any) => v.localizedValue || v.value),
    }));
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, treeId, categoryId, required: aspects.filter((x: any)=>x.required), optional: aspects.filter((x: any)=>!x.required) }) };
  } catch (e: any) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "taxonomy-aspects error", detail: e?.message || String(e) }) };
  }
};
