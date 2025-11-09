import type { CategoryDef } from "./taxonomy-schema.js";
import { listCategories, getCategoryById } from "./taxonomy-store.js";

const CACHE_TTL_MS = 30_000;
let cache: { categories: CategoryDef[]; expiresAt: number } | null = null;

function normalize(value?: string | null): string {
  if (!value) return "";
  return value.toLowerCase().trim();
}

function collectHaystack(group: Record<string, any>): string {
  const parts: string[] = [];
  ["brand", "product", "variant", "category"].forEach((key) => {
    const val = group?.[key];
    if (typeof val === "string") parts.push(val);
  });
  const claims = Array.isArray(group?.claims) ? group.claims : [];
  claims.forEach((claim: unknown) => {
    if (typeof claim === "string") parts.push(claim);
  });
  return normalize(parts.join(" "));
}

async function getCategories(): Promise<CategoryDef[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.categories;
  }
  const categories = await listCategories();
  cache = { categories, expiresAt: now + CACHE_TTL_MS };
  return categories;
}

export async function pickCategoryForGroup(group: Record<string, any>): Promise<CategoryDef | null> {
  // If the group has a category object with an ID (e.g., from ChatGPT), try to look it up directly
  if (group.category && typeof group.category === 'object') {
    const categoryId = String(group.category.id || group.category.categoryId || '').trim();
    if (categoryId) {
      const cached = await getCategoryById(categoryId);
      if (cached) {
        console.log('[pickCategoryForGroup] Found category by ID:', categoryId);
        return cached;
      }
    }
    
    // Try to match by category title/path
    const categoryTitle = String(group.category.title || '').trim();
    if (categoryTitle) {
      const categories = await getCategories();
      const titleNorm = normalize(categoryTitle);
      console.log('[pickCategoryForGroup] Searching for category by title:', categoryTitle);
      
      // Look for exact title match or path match
      for (const cat of categories) {
        const catTitleNorm = normalize(cat.title || '');
        const catSlugNorm = normalize(cat.slug || '');
        
        if (catTitleNorm === titleNorm || catSlugNorm === titleNorm) {
          console.log('[pickCategoryForGroup] Exact match found:', cat.id, cat.title);
          return cat;
        }
        
        // Check if the category path matches (e.g., "Books > Biography" matches category with that path)
        if (titleNorm.includes('>')) {
          const parts = titleNorm.split('>').map(p => p.trim());
          const lastPart = parts[parts.length - 1];
          if (catTitleNorm.includes(lastPart) || catSlugNorm.includes(lastPart)) {
            console.log('[pickCategoryForGroup] Partial path match found:', cat.id, cat.title);
            return cat;
          }
        }
      }
      console.log('[pickCategoryForGroup] No category match found for title:', categoryTitle);
    }
  }

  const categories = await getCategories();
  if (!categories.length) return null;

  const haystack = collectHaystack(group);
  if (!haystack) return null;

  console.log('[pickCategoryForGroup] Falling back to scoreRules matching with haystack:', haystack.slice(0, 100));

  let best: CategoryDef | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const cat of categories) {
    const includes = Array.isArray(cat.scoreRules?.includes)
      ? cat.scoreRules!.includes.map((entry) => normalize(entry))
      : [];
    const excludes = Array.isArray(cat.scoreRules?.excludes)
      ? cat.scoreRules!.excludes.map((entry) => normalize(entry))
      : [];
    const minScore = cat.scoreRules?.minScore ?? 1;

    let score = 0;
    for (const needle of includes) {
      if (needle && haystack.includes(needle)) score += 1;
    }
    for (const block of excludes) {
      if (block && haystack.includes(block)) score -= 2;
    }

    if (score > bestScore && score >= minScore) {
      best = cat;
      bestScore = score;
    }
  }

  if (best) {
    console.log('[pickCategoryForGroup] ScoreRules match found:', best.id, best.title, 'score:', bestScore);
  } else {
    console.log('[pickCategoryForGroup] No scoreRules match found');
  }

  return best;
}
