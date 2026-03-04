/**
 * ebay-taxonomy.service.ts — Platform-agnostic service for eBay Category/Taxonomy lookups.
 *
 * Mirrors the business logic previously inlined in:
 *   netlify/functions/ebay-category-suggestions.ts
 *
 * No HTTP framework dependencies. Uses application-level OAuth (no user auth required).
 */

import { appAccessToken, tokenHosts } from '../lib/_common.js';

// ---------------------------------------------------------------------------
// getCategorySuggestions
// ---------------------------------------------------------------------------

export interface CategorySuggestion {
  categoryId: string;
  categoryName: string;
  categoryPath: string;
  relevance?: unknown;
}

export interface GetCategorySuggestionsResult {
  ok: true;
  treeId: string;
  suggestions: CategorySuggestion[];
}

/**
 * Fetch eBay category suggestions for a search query.
 *
 * Uses the application-level OAuth token (not user-scoped), so no userId required.
 *
 * @throws if the eBay taxonomy API is unavailable or returns no tree ID.
 */
export async function getCategorySuggestions(
  q: string,
): Promise<GetCategorySuggestionsResult> {
  const { access_token } = await appAccessToken([
    'https://api.ebay.com/oauth/api_scope/commerce.taxonomy.readonly',
  ]);
  const { apiHost } = tokenHosts(process.env.EBAY_ENV);
  const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';

  const headers: Record<string, string> = {
    Authorization: `Bearer ${access_token}`,
    Accept: 'application/json',
    'Accept-Language': 'en-US',
    'Content-Language': 'en-US',
    'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
  };

  // Resolve default category tree ID for the marketplace
  const treeRes = await fetch(
    `${apiHost}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE_ID}`,
    { headers },
  );
  const treeJson = await treeRes.json() as Record<string, unknown>;
  const treeId = treeJson?.categoryTreeId as string | undefined;
  if (!treeId) {
    throw new Error(`No category tree ID returned: ${JSON.stringify(treeJson)}`);
  }

  // Fetch suggestions
  const sugRes = await fetch(
    `${apiHost}/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions?q=${encodeURIComponent(q)}`,
    { headers },
  );
  const sugJson = await sugRes.json() as { categorySuggestions?: unknown[] };

  const suggestions: CategorySuggestion[] = (sugJson?.categorySuggestions ?? []).map(
    (c: any) => ({
      categoryId: c.category?.categoryId as string,
      categoryName: c.category?.categoryName as string,
      categoryPath: (c.categoryTreeNodeAncestors as any[] || [])
        .map((a: any) => a.categoryName as string)
        .concat([c.category?.categoryName as string])
        .join(' > '),
      relevance: (c.relevancy ?? c.relevancyScore) as unknown,
    }),
  );

  return { ok: true, treeId, suggestions };
}
