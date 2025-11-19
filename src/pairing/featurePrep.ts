// Build normalized features from Prompt-1 JSON.
// Input: { groups, imageInsights }
// Output: a Map<string, FeatureRow> keyed by image url.

/**
 * Extract canonical key from URL (strips prefixes like EBAY_, ebay/, etc.)
 */
function urlKey(u: string): string {
  const t = (u || '').trim().toLowerCase().replace(/\s*\|\s*/g, '/');
  const noQuery = t.split('?')[0];
  const base = noQuery.split('/').pop() || noQuery;
  return base.replace(/^(ebay[_-])/i, '');   // strip uploader prefix
}

/**
 * Extract basename from URL or path (filename without directory)
 * Handles both full URLs and simple filenames
 */
function basenameFrom(u: string): string {
  try {
    if (!u) return "";
    const trimmed = u.trim();
    if (!trimmed) return "";
    const noQuery = trimmed.split("?")[0];
    const parts = noQuery.split("/");
    return parts[parts.length - 1] || "";
  } catch {
    return u;
  }
}

export type Role = 'front' | 'back' | 'side' | 'other';

export interface FeatureRow {
  url: string;
  role: Role;
  originalRole?: Role; // Phase 5a.3: Immutable Vision ground truth
  brandNorm: string; // lowercase, strip inc/llc/co/ltd/corp/company, collapse spaces
  productTokens: string[]; // lowercase tokens (a-z0-9+-.)
  variantTokens: string[];
  sizeCanonical: string | null; // ml/g when possible (fl oz→ml, oz→g), else null/original
  packagingHint: 'pouch' | 'dropper-bottle' | 'bottle' | 'jar' | 'tube' | 'canister' | 'other';
  categoryPath: string | null; // as-is from Prompt 1
  categoryTail: string; // last 1–2 nodes
  hasText: boolean;
  colorKey: string; // lowercase-kebab
  textExtracted: string; // full OCR text for cosmetic back cue detection
}

type Analysis = {
  groups: any[];
  imageInsights: any[];
};

function normalizeBrand(raw: string): string {
  if (!raw || raw === 'Unknown') return '';
  
  // Normalize to lowercase and remove corporate suffixes
  let normalized = raw
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|company|brands|supplements|nutrition|wellness|fuel)\b\.?/gi, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  
  // Handle common brand variations - extract core brand name
  // "jocko fuel" -> "jocko", "root brands" -> "root", "root wellness" -> "root"
  // "naked nutrition" -> "naked", "ryse supplements" -> "ryse"
  // "rkmd rob keller md" -> "rkmd", "evereden barbie collaboration" -> "evereden"
  const tokens = normalized.split(/\s+/);
  
  // If brand has multiple words, keep first significant word (unless it's a common prefix)
  if (tokens.length > 1) {
    // Filter out generic words that shouldn't be the primary brand identifier
    const genericWords = ['by', 'from', 'the', 'a', 'an'];
    const significantTokens = tokens.filter(t => !genericWords.includes(t) && t.length > 0);
    
    // Return first significant token as the core brand
    if (significantTokens.length > 0) {
      normalized = significantTokens[0];
    }
  }
  
  return normalized;
}

function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9+.-]+/)
    .filter(t => t.length > 0);
}

function canonicalizeSize(size: string, categoryPath: string): string | null {
  if (!size) return null;
  
  const needsConversion = /supplement|vitamin|nutrition|food|beverage|hair|cosmetic|skin/i.test(categoryPath || '');
  if (!needsConversion) return size;

  // Check if already has g unit at the end
  const gMatch = size.match(/(\d+)\s*g\b/i);
  if (gMatch) {
    return `${gMatch[1]}g`;
  }

  // fl oz → ml
  const flOzMatch = size.match(/([\d.]+)\s*fl\s*oz/i);
  if (flOzMatch) {
    const ml = Math.round(parseFloat(flOzMatch[1]) * 29.573);
    return `${ml}ml`;
  }

  // oz → g (but not fl oz)
  const ozMatch = size.match(/([\d.]+)\s*oz(?!\s*\()/i);
  if (ozMatch && !/fl/i.test(size)) {
    const g = Math.round(parseFloat(ozMatch[1]) * 28.35);
    return `${g}g`;
  }

  return size;
}

function extractPackaging(visualDesc: string): FeatureRow['packagingHint'] {
  if (!visualDesc) return 'other';
  const lower = visualDesc.toLowerCase();
  
  if (/resealable|stand-up|pouch/i.test(lower)) return 'pouch';
  if (/dropper|pipette|tincture/i.test(lower)) return 'dropper-bottle';
  if (/\bbottle\b/i.test(lower)) return 'bottle';
  if (/\bjar\b/i.test(lower)) return 'jar';
  if (/\btube\b/i.test(lower)) return 'tube';
  if (/canister|tub/i.test(lower)) return 'canister';
  
  return 'other';
}

function extractCategoryTail(categoryPath: string | null): string {
  if (!categoryPath) return '';
  const parts = categoryPath.split(/\s*>\s*/);
  if (parts.length >= 2) {
    return parts.slice(-2).join(' > ');
  }
  return parts[parts.length - 1] || '';
}

function normalizeColor(color: string): string {
  if (!color) return '';
  return color.toLowerCase().replace(/\s+/g, '-');
}

export function buildFeatures(analysis: Analysis): Map<string, FeatureRow> {
  const features = new Map<string, FeatureRow>();
  
  // Build a map of basename -> group data for flexible URL matching
  // Groups may have short filenames or full URLs in images array
  const groupByBase = new Map<string, any>();
  for (const group of analysis.groups) {
    // Try to get any URL from the group (could be primaryImageUrl or first image)
    const url = group.primaryImageUrl || group.images?.[0];
    if (url) {
      const base = basenameFrom(url).toLowerCase();
      if (base && !groupByBase.has(base)) {
        groupByBase.set(base, group);
      }
    }
    
    // Also index by all images in the array (some groups have multiple URLs)
    if (Array.isArray(group.images)) {
      for (const imgUrl of group.images) {
        if (imgUrl) {
          const base = basenameFrom(imgUrl).toLowerCase();
          if (base && !groupByBase.has(base)) {
            groupByBase.set(base, group);
          }
        }
      }
    }
  }
  
  console.log(`[buildFeatures] Built basename map with ${groupByBase.size} entries from ${analysis.groups.length} groups`);
  
  // Process each insight and match to group by basename
  let matched = 0;
  let skipped = 0;
  for (const insight of analysis.imageInsights) {
    const url = insight.url;
    const key = urlKey(url);  // Canonicalize to key
    const base = basenameFrom(url).toLowerCase();
    const group = groupByBase.get(base);
    
    if (!group) {
      skipped++;
      console.log(`[buildFeatures] SKIPPED: No group match for basename="${base}" from url="${url}"`);
      continue; // Skip insights without matching groups
    }
    
    matched++;
    // Phase 5a.3: Use originalRole as fallback to preserve Vision ground truth
    const role = ((insight as any).originalRole || insight.role || 'other') as Role;
    const brandNorm = normalizeBrand(group.brand || '');
    const productTokens = tokenize(group.product || '');
    const variantTokens = tokenize(group.variant || '');
    const sizeCanonical = canonicalizeSize(group.size || '', group.categoryPath || '');
    const packagingHint = extractPackaging(insight.visualDescription || '');
    const categoryPath = group.categoryPath || null;
    const categoryTail = extractCategoryTail(categoryPath);
    const hasText = insight.hasVisibleText ?? false;
    const colorKey = normalizeColor(insight.dominantColor || '');
    const textExtracted = insight.textExtracted || '';
    
    features.set(key, {  // Use canonical key instead of raw url
      url: key,           // Store canonical key as url
      role,
      originalRole: (insight as any).originalRole, // Phase 5a.3: Preserve for downstream
      brandNorm,
      productTokens,
      variantTokens,
      sizeCanonical,
      packagingHint,
      categoryPath,
      categoryTail,
      hasText,
      colorKey,
      textExtracted
    });
  }
  
  console.log(`[buildFeatures] Matched ${matched} insights to groups, skipped ${skipped}`);
  return features;
}
