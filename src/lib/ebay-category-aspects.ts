/**
 * eBay Category Aspects Fetcher
 * 
 * Fetches the complete list of aspects (item specifics) for an eBay category.
 * This is used to pass the full aspect list to GPT for more complete draft generation.
 */

import { tokenHosts, appAccessToken } from './_common.js';

export interface CategoryAspect {
  name: string;
  required: boolean;
  usage?: string;
  dataType?: string;
  multi: boolean;
  forVariations: boolean;
  values: string[]; // Pre-defined values if selection-only
  mode?: string; // 'SELECTION_ONLY' or 'FREE_TEXT'
}

export interface CategoryAspectsResult {
  categoryId: string;
  treeId: string;
  required: CategoryAspect[];
  optional: CategoryAspect[];
  all: CategoryAspect[];
}

// In-memory cache for category aspects (lasts for function lifetime)
const aspectsCache: Map<string, { data: CategoryAspectsResult; timestamp: number }> = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache

/**
 * Fetch all aspects for an eBay category
 * @param categoryId The eBay category ID
 * @param options Optional configuration
 * @returns CategoryAspectsResult with required and optional aspects
 */
export async function fetchCategoryAspects(
  categoryId: string,
  options: {
    treeId?: string;
    marketplace?: string;
    skipCache?: boolean;
  } = {}
): Promise<CategoryAspectsResult | null> {
  if (!categoryId) return null;

  const cacheKey = `${categoryId}:${options.treeId || '0'}`;
  
  // Check cache first
  if (!options.skipCache) {
    const cached = aspectsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      console.log(`[ebay-category-aspects] Cache hit for category ${categoryId}`);
      return cached.data;
    }
  }

  try {
    const MARKETPLACE_ID = options.marketplace || process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    
    // Get app access token
    const { access_token } = await appAccessToken(['https://api.ebay.com/oauth/api_scope']);
    
    // Get tree ID if not provided
    let treeId = options.treeId;
    if (!treeId) {
      const treeRes = await fetch(
        `${apiHost}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE_ID}`,
        { headers: { Authorization: `Bearer ${access_token}` } }
      );
      const treeJson = await treeRes.json();
      treeId = String(treeJson?.categoryTreeId || '0');
    }

    // Fetch aspects for category
    const url = `${apiHost}/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
    
    if (!res.ok) {
      console.error(`[ebay-category-aspects] Failed to fetch aspects: ${res.status}`);
      return null;
    }
    
    const json = await res.json();
    const rawAspects = json?.aspects || [];
    
    const aspects: CategoryAspect[] = rawAspects.map((a: any) => ({
      name: a.localizedAspectName || a.aspectName,
      required: !!a.aspectConstraint?.aspectRequired,
      usage: a.aspectConstraint?.aspectUsage,
      dataType: a.aspectConstraint?.aspectDataType,
      multi: a.aspectConstraint?.itemToAspectCardinality === 'MULTI',
      forVariations: !!a.aspectConstraint?.aspectEnabledForVariations,
      mode: a.aspectConstraint?.aspectMode,
      values: (a.aspectValues || []).slice(0, 50).map((v: any) => v.localizedValue || v.value),
    }));

    const result: CategoryAspectsResult = {
      categoryId,
      treeId,
      required: aspects.filter(a => a.required),
      optional: aspects.filter(a => !a.required),
      all: aspects,
    };

    // Cache the result
    aspectsCache.set(cacheKey, { data: result, timestamp: Date.now() });
    console.log(`[ebay-category-aspects] Fetched ${aspects.length} aspects for category ${categoryId} (${result.required.length} required, ${result.optional.length} optional)`);

    return result;
  } catch (err) {
    console.error(`[ebay-category-aspects] Error fetching aspects:`, err);
    return null;
  }
}

/**
 * Format aspects list for GPT prompt
 * Returns a string listing all aspect names with their constraints
 */
export function formatAspectsForPrompt(aspects: CategoryAspectsResult | null): string {
  if (!aspects) return '';
  
  const lines: string[] = [];
  
  // Required aspects first
  if (aspects.required.length > 0) {
    lines.push('REQUIRED ASPECTS (must fill these):');
    for (const asp of aspects.required) {
      const valuesHint = asp.values.length > 0 
        ? ` [allowed: ${asp.values.slice(0, 8).join(', ')}${asp.values.length > 8 ? '...' : ''}]`
        : '';
      const multiHint = asp.multi ? ' (can have multiple values)' : '';
      lines.push(`  - ${asp.name}${valuesHint}${multiHint}`);
    }
    lines.push('');
  }
  
  // Optional aspects - show all but prioritize ones with predefined values
  if (aspects.optional.length > 0) {
    lines.push('OPTIONAL ASPECTS (fill as many as possible for better search ranking):');
    
    // Sort: aspects with predefined values first, then alphabetically
    const sorted = [...aspects.optional].sort((a, b) => {
      if (a.values.length > 0 && b.values.length === 0) return -1;
      if (a.values.length === 0 && b.values.length > 0) return 1;
      return a.name.localeCompare(b.name);
    });
    
    for (const asp of sorted) {
      const valuesHint = asp.values.length > 0 
        ? ` [suggested: ${asp.values.slice(0, 5).join(', ')}${asp.values.length > 5 ? '...' : ''}]`
        : '';
      const multiHint = asp.multi ? ' (multiple)' : '';
      lines.push(`  - ${asp.name}${valuesHint}${multiHint}`);
    }
  }
  
  return lines.join('\n');
}

/**
 * Get a simple list of aspect names for quick reference
 */
export function getAspectNames(aspects: CategoryAspectsResult | null): { required: string[]; optional: string[] } {
  if (!aspects) return { required: [], optional: [] };
  return {
    required: aspects.required.map(a => a.name),
    optional: aspects.optional.map(a => a.name),
  };
}
