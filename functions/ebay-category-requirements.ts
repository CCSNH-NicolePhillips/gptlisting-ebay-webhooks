import type { Handler } from "@netlify/functions";
import { tokenHosts, appAccessToken, accessTokenFromRefresh } from "./_common.js";
import { tokensStore } from "./_blobs.js";

export const handler: Handler = async (event) => {
  try {
    const categoryId = event.queryStringParameters?.categoryId;
    if (!categoryId) return { statusCode: 400, body: JSON.stringify({ error: "missing categoryId" }) };
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
    async function getToken(): Promise<string> {
      try {
        const a = await appAccessToken(["https://api.ebay.com/oauth/api_scope"]);
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
    const bearer = await getToken();
    const headers = {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json",
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
    } as Record<string, string>;

    // 1) Get allowed item conditions for the category
    const condUrl = `${apiHost}/sell/metadata/v1/marketplace/${MARKETPLACE_ID}/get_item_condition_policies?category_id=${encodeURIComponent(categoryId)}`;
  const condRes = await fetch(condUrl, { headers });
    const condJson = await condRes.json().catch(() => ({}));

  // 2) Resolve default taxonomy tree id for this marketplace
  const treeIdRes = await fetch(`${apiHost}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE_ID}`, { headers });
  const treeJson = await treeIdRes.json().catch(() => ({}));
  const treeId = treeJson?.categoryTreeId ?? '0';

  // 3) Get required and optional aspects for the category using the resolved tree id
  const taxUrl = `${apiHost}/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`;
  const taxRes = await fetch(taxUrl, { headers });
    const taxJson = await taxRes.json().catch(() => ({}));

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
        allowedConditions,
        requiredAspects,
        optionalAspects,
        raw: { conditions: condJson, taxonomy: taxJson, tree: treeJson },
      }),
    };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: "category-requirements error", detail: e?.message || String(e) }) };
  }
};
