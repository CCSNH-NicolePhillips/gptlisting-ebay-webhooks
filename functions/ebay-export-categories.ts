import type { Handler } from "@netlify/functions";
import { tokenHosts, appAccessToken } from "./_common.js";
import { cacheStore } from "./_blobs.js";

type FlatCategory = { categoryId: string; categoryName: string; categoryPath: string };

export const handler: Handler = async (event) => {
  try {
    const MARKETPLACE_ID = (event.queryStringParameters?.marketplaceId || process.env.EBAY_MARKETPLACE_ID || "EBAY_US").trim();
    const format = (event.queryStringParameters?.format || "csv").toLowerCase(); // csv | json
    const refresh = (event.queryStringParameters?.refresh || "").toLowerCase(); // "1" | "true"
    const forceRefresh = refresh === "1" || refresh === "true";

    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const store = cacheStore();
    const treeCacheKey = `taxonomy-tree-${MARKETPLACE_ID}.json`;
    const jsonOutKey = `taxonomy-categories-${MARKETPLACE_ID}.json`;
    const csvOutKey = `taxonomy-categories-${MARKETPLACE_ID}.csv`;

    // Helper to fetch and flatten taxonomy tree
    async function fetchAndFlatten(): Promise<{ treeId: string; categories: FlatCategory[] }>{
      const { access_token } = await appAccessToken([
        "https://api.ebay.com/oauth/api_scope/commerce.taxonomy.readonly",
      ]);
      const headers = {
        Authorization: `Bearer ${access_token}`,
        Accept: "application/json",
        "Accept-Language": "en-US",
        "Content-Language": "en-US",
        "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
      } as Record<string, string>;

      const tRes = await fetch(`${apiHost}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE_ID}`, { headers });
      const tJson = await tRes.json();
      const treeId = tJson?.categoryTreeId;
      if (!treeId) throw new Error("No taxonomy tree id for marketplace " + MARKETPLACE_ID);

      const res = await fetch(`${apiHost}/commerce/taxonomy/v1/category_tree/${treeId}`, { headers });
      const full = await res.json();
      const root = full?.rootCategoryNode || full;

      function flatten(node: any, path: string[] = []): FlatCategory[] {
        if (!node) return [];
        const cat = node.categoryTreeNode?.category || node.category || {};
        const name: string | undefined = cat.categoryName || node.categoryName;
        const id: string | undefined = cat.categoryId || node.categoryId;
        const children = node.childCategoryTreeNodes || node.children || [];
        const here = id && name ? [{ categoryId: String(id), categoryName: String(name), categoryPath: [...path, String(name)].join(" > ") }] : [];
        const nextPath = name ? [...path, String(name)] : path;
        const kids = children.flatMap((c: any) => flatten(c, nextPath));
        return [...here, ...kids];
      }

      const categories = flatten(root);
      return { treeId, categories };
    }

    // Try cache first (from prior runs or from ebay-category-tree function)
    let cachedTree = await store.get(treeCacheKey, { type: "json" }) as any;
    let categories: FlatCategory[] | undefined = undefined;
    let treeId: string | undefined = cachedTree?.treeId;

    if (!forceRefresh) {
      // Use pre-computed categories if present
      const preJson = (await store.get(jsonOutKey, { type: "json" }).catch(() => undefined)) as FlatCategory[] | undefined;
      if (preJson && Array.isArray(preJson)) {
        categories = preJson;
      }
    }

    if (!categories) {
      // Either forced refresh or nothing cached; fetch fresh
      const fresh = await fetchAndFlatten();
      categories = fresh.categories;
      treeId = fresh.treeId;
      // Persist tree snapshot and derived outputs
      await store.setJSON(treeCacheKey, { treeId, categories });
      await store.setJSON(jsonOutKey, categories);
      // Also write CSV
      const csv = toCSV(categories);
  await store.set(csvOutKey, csv);
    } else {
      // Ensure CSV exists alongside JSON for convenience
      const maybeCsv = await store.get(csvOutKey).catch(() => undefined);
      if (!maybeCsv) {
        const csv = toCSV(categories);
        await store.set(csvOutKey, csv);
      }
    }

    // Respond with requested format
    if (format === "json") {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename=taxonomy-categories-${MARKETPLACE_ID}.json`,
        } as Record<string, string>,
        body: JSON.stringify({ ok: true, marketplaceId: MARKETPLACE_ID, treeId: treeId || "", count: categories.length, categories }),
      };
    }

    // default CSV
    const csv = toCSV(categories);
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename=taxonomy-categories-${MARKETPLACE_ID}.csv`,
      } as Record<string, string>,
      body: csv,
    };
  } catch (e: any) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "export-categories error", detail: e?.message || String(e) }) };
  }
};

function toCSV(rows: FlatCategory[]): string {
  const escape = (s: string) => '"' + s.replace(/"/g, '""') + '"';
  const header = ["categoryId", "categoryName", "categoryPath"].join(",");
  const body = rows.map(r => [r.categoryId, r.categoryName, r.categoryPath].map(escape).join(",")).join("\n");
  return header + "\n" + body + "\n";
}
