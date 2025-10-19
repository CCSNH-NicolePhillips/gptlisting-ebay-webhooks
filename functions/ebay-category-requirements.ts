import type { Handler } from "@netlify/functions";
import { tokenHosts, appAccessToken, accessTokenFromRefresh } from "./_common.js";
import { tokensStore } from "./_blobs.js";

export const handler: Handler = async (event) => {
  try {
    const categoryId = event.queryStringParameters?.categoryId;
    if (!categoryId) return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "missing categoryId" }) };
    const qTreeId = (event.queryStringParameters?.treeId || "").trim();
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";

    async function getToken(): Promise<string> {
      // Prefer app token; if scope issues, fallback to user refresh token
      try {
        // Use taxonomy readonly scope for best compatibility
        const a = await appAccessToken(["https://api.ebay.com/oauth/api_scope/commerce.taxonomy.readonly"]);
        return a.access_token;
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (msg.includes("invalid_scope")) {
          const store = tokensStore();
          const saved = (await store.get("ebay.json", { type: "json" })) as any;
          const refresh = saved?.refresh_token as string | undefined;
          if (!refresh) throw new Error("invalid_scope and no user refresh token; connect eBay first");
          const u = await accessTokenFromRefresh(refresh);
          return u.access_token;
        }
        throw e;
      }
    }

    async function fetchJsonWithRetry(url: string, headers: Record<string, string>, label: string, retries = 1): Promise<any> {
      let lastErr: any;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const r = await fetch(url, { headers });
          const text = await r.text();
          const data = text ? (JSON.parse(text) as any) : {};
          if (!r.ok) {
            if (r.status === 502 || r.status === 503) {
              lastErr = new Error(`${label} upstream ${r.status}`);
              if (attempt < retries) { await new Promise(res => setTimeout(res, 350)); continue; }
            }
            const err = new Error(`${label} ${r.status}`);
            (err as any).status = r.status; (err as any).response = data; throw err;
          }
          return data;
        } catch (e: any) {
          lastErr = e;
          if (attempt < retries) { await new Promise(res => setTimeout(res, 350)); continue; }
        }
      }
      throw lastErr;
    }

    const bearer = await getToken();
    const headers = {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json",
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
    } as Record<string, string>;

    // 1) Fetch conditions and treeId concurrently (if treeId not provided)
    const condUrl = `${apiHost}/sell/metadata/v1/marketplace/${MARKETPLACE_ID}/get_item_condition_policies?category_id=${encodeURIComponent(categoryId)}`;
    const condPromise = fetchJsonWithRetry(condUrl, headers, "conditions", 1).catch((e) => { console.error("conditions fetch error", e); return {}; });
    const treePromise = (async () => {
      if (qTreeId) return { categoryTreeId: qTreeId } as any;
      const tUrl = `${apiHost}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE_ID}`;
      return fetchJsonWithRetry(tUrl, headers, "treeId", 1);
    })();

    const [condJson, treeJson] = await Promise.all([condPromise, treePromise]);
    const treeId = String((treeJson?.categoryTreeId ?? qTreeId ?? "0") || "0");

    // 2) Fetch taxonomy aspects for the category (retry once on 502/503)
    const taxUrl = `${apiHost}/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`;
    const taxJson = await fetchJsonWithRetry(taxUrl, headers, "taxonomy", 1).catch((e) => { console.error("taxonomy fetch error", e); return {}; });

    // Normalize output
    const allowedConditions = condJson?.itemConditionPolicies?.[0]?.itemConditions || [];
    const aspects = taxJson?.aspects || [];
    const requiredAspects = aspects.filter((a: any) => a.aspectConstraint?.itemToAspectCardinality === 'SINGLE' && a.aspectConstraint?.aspectRequired);
    const optionalAspects = aspects.filter((a: any) => !a.aspectConstraint?.aspectRequired);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        marketplaceId: MARKETPLACE_ID,
        categoryId,
        treeId,
        allowedConditions,
        requiredAspects,
        optionalAspects,
        raw: { conditions: condJson, taxonomy: taxJson, tree: treeJson },
      }),
    };
  } catch (e: any) {
    const detail = e?.response || e?.message || String(e);
    console.error('category-requirements error:', detail);
    const status = (e && typeof e.status === 'number') ? e.status : 500;
    return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "category-requirements error", detail }) };
  }
};
