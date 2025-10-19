import type { Handler } from "@netlify/functions";
import { tokenHosts, appAccessToken } from "./_common.js";

type BrowseNode = { id: string; name: string; path: string; leaf: boolean };

export const handler: Handler = async (event) => {
  try {
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const { access_token } = await appAccessToken(["https://api.ebay.com/oauth/api_scope"]);
    const headers = { Authorization: `Bearer ${access_token}` } as Record<string, string>;
    const categoryId = event.queryStringParameters?.categoryId;

    // Resolve default tree id
    const tRes = await fetch(`${apiHost}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE_ID}`, { headers });
    const tJson = await tRes.json();
    const treeId = tJson?.categoryTreeId;
    if (!treeId) return { statusCode: 500, body: JSON.stringify({ error: "no tree id", detail: tJson }) };

    function mapChildren(node: any, ancestors: any[] = []): { node: BrowseNode; children: BrowseNode[]; breadcrumbs: BrowseNode[] } {
      const cat = node.categoryTreeNode || node.categorySubtreeNode || node;
      const category = cat?.category || node.category || {};
      const name = category?.categoryName || node.categoryName;
      const id = String(category?.categoryId || node.categoryId);
      const kids = (cat?.childCategoryTreeNodes || node.childCategoryTreeNodes || []).map((c: any) => {
        const cId = String(c.category?.categoryId || c.categoryId);
        const cName = c.category?.categoryName || c.categoryName;
        const leaf = !c.childCategoryTreeNodes || c.childCategoryTreeNodes.length === 0;
        return { id: cId, name: cName, path: [...ancestors.map(a=>a.name), name, cName].join(" > "), leaf } as BrowseNode;
      });
      const here: BrowseNode = { id, name, path: [...ancestors.map(a=>a.name), name].join(" > "), leaf: kids.length === 0 };
      const crumbs: BrowseNode[] = [...ancestors, here];
      return { node: here, children: kids, breadcrumbs: crumbs };
    }

    if (!categoryId) {
      // Root browse: fetch tree root
      const r = await fetch(`${apiHost}/commerce/taxonomy/v1/category_tree/${treeId}`, { headers });
      const j = await r.json();
      const root = j.rootCategoryNode;
      const res = mapChildren(root, []);
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, treeId, ...res }) };
    }

    // Subtree browse
    const url = `${apiHost}/commerce/taxonomy/v1/category_tree/${treeId}/get_category_subtree?category_id=${encodeURIComponent(categoryId)}`;
    const r = await fetch(url, { headers });
    const j = await r.json();
    const ancestors = (j?.categorySubtreeNode?.categoryTreeNodeAncestors || []).map((a: any) => ({ id: String(a.category?.categoryId), name: a.category?.categoryName, path: "", leaf: false } as BrowseNode));
    const res = mapChildren(j, ancestors);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, treeId, ...res }) };
  } catch (e: any) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "category-browse error", detail: e?.message || String(e) }) };
  }
};
