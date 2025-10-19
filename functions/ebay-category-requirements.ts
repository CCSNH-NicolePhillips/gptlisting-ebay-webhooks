import type { Handler } from "@netlify/functions";
import { tokenHosts, appAccessToken } from "./_common.js";

export const handler: Handler = async (event) => {
  try {
    const categoryId = event.queryStringParameters?.categoryId;
    if (!categoryId) return { statusCode: 400, body: JSON.stringify({ error: "missing categoryId" }) };
    const { access_token } = await appAccessToken([
      "https://api.ebay.com/oauth/api_scope/commerce.taxonomy.readonly",
      "https://api.ebay.com/oauth/api_scope/sell.metadata.readonly",
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

    // 1) Get allowed item conditions for the category
    const condUrl = `${apiHost}/sell/metadata/v1/marketplace/${MARKETPLACE_ID}/get_item_condition_policies?category_id=${encodeURIComponent(categoryId)}`;
    const condRes = await fetch(condUrl, { headers });
    const condJson = await condRes.json().catch(() => ({}));

    // 2) Get required and optional aspects for the category
    const taxUrl = `${apiHost}/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`;
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
        raw: { conditions: condJson, taxonomy: taxJson },
      }),
    };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: "category-requirements error", detail: e?.message || String(e) }) };
  }
};
