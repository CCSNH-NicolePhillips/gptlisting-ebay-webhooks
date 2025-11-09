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
      
      // Look for exact title match or slug match first
      for (const cat of categories) {
        const catTitleNorm = normalize(cat.title || '');
        const catSlugNorm = normalize(cat.slug || '');
        
        if (catTitleNorm === titleNorm || catSlugNorm === titleNorm) {
          console.log('[pickCategoryForGroup] Exact match found:', cat.id, cat.title);
          return cat;
        }
      }
      
      // If we have a path like "Books > Biography", match ALL parts in sequence
      if (titleNorm.includes('>')) {
        const parts = titleNorm.split('>').map(p => p.trim());
        console.log('[pickCategoryForGroup] Matching category path parts:', parts);
        
        for (const cat of categories) {
          const catTitleNorm = normalize(cat.title || '');
          const catSlugNorm = normalize(cat.slug || '');
          
          // All parts must appear in order in the category title/slug
          let allMatch = true;
          for (const part of parts) {
            if (!catTitleNorm.includes(part) && !catSlugNorm.includes(part)) {
              allMatch = false;
              break;
            }
          }
          
          if (allMatch) {
            console.log('[pickCategoryForGroup] Full path match found:', cat.id, cat.title);
            return cat;
          }
        }
      }
      console.log('[pickCategoryForGroup] No category match found for title:', categoryTitle);
      
      // If category path matching failed, extract keywords to help scoreRules matching
      // e.g., "Books > Biography" -> add "books" and "biography" to haystack
      if (titleNorm.includes('>')) {
        const categoryKeywords = titleNorm.split('>').map(p => p.trim()).join(' ');
        const enhancedHaystack = collectHaystack(group) + ' ' + categoryKeywords;
        console.log('[pickCategoryForGroup] Enhanced haystack with category keywords:', enhancedHaystack.slice(0, 150));
        
        // Try scoreRules matching with enhanced haystack
        const categories = await getCategories();
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
            if (needle && enhancedHaystack.includes(needle)) score += 1;
          }
          for (const block of excludes) {
            if (block && enhancedHaystack.includes(block)) score -= 2;
          }

          if (score > bestScore && score >= minScore) {
            best = cat;
            bestScore = score;
          }
        }

        if (best) {
          console.log('[pickCategoryForGroup] Enhanced scoreRules match found:', best.id, best.title, 'score:', bestScore);
          return best;
        }
      }
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
