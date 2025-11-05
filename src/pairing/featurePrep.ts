// Build normalized features from Prompt-1 JSON.
// Input: { groups, imageInsights }
// Output: a Map<string, FeatureRow> keyed by image url.

export type Role = 'front' | 'back' | 'side' | 'other';

export interface FeatureRow {
  url: string;
  role: Role;
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
  return raw
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|company)\b\.?/gi, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
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
  
  // Build a map of url -> group data
  const groupByUrl = new Map<string, any>();
  for (const group of analysis.groups) {
    const url = group.primaryImageUrl || group.images?.[0];
    if (url) {
      groupByUrl.set(url, group);
    }
  }
  
  // Process each insight
  for (const insight of analysis.imageInsights) {
    const url = insight.url;
    const group = groupByUrl.get(url);
    
    if (!group) continue; // Skip insights without matching groups
    
    const role = (insight.role || 'other') as Role;
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
    
    features.set(url, {
      url,
      role,
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
  
  return features;
}
