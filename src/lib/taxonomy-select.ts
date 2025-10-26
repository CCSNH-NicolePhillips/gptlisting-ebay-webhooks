import type { CategoryDef } from "./taxonomy-schema.js";
import { listCategories } from "./taxonomy-store.js";

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
  const categories = await getCategories();
  if (!categories.length) return null;

  const haystack = collectHaystack(group);
  if (!haystack) return null;

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

  return best;
}
