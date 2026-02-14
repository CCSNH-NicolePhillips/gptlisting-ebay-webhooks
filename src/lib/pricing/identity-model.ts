import { createHash } from 'crypto';

export type SizeUnit = 'oz' | 'fl oz' | 'ml' | 'l' | 'g' | 'kg' | 'lb' | 'ct' | 'caps' | 'tablets';

export interface CanonicalIdentity {
  brand: string;
  productLine: string;
  variant: string | null;
  size: { value: number; unit: SizeUnit } | null;
  packCount: number;
  condition: 'new' | 'open-box' | 'used' | 'for-parts';
  upc: string | null;
  mpn: string | null;
  keywords: string[];
  identityHash: string;
}

const SIZE_PATTERNS: { regex: RegExp; unit: SizeUnit }[] = [
  { regex: /(\d+(?:\.\d+)?)\s*fl\.?\s*oz/i, unit: 'fl oz' },
  { regex: /(\d+(?:\.\d+)?)\s*oz/i, unit: 'oz' },
  { regex: /(\d+(?:\.\d+)?)\s*ml\b/i, unit: 'ml' },
  { regex: /(\d+(?:\.\d+)?)\s*(?:l\b|liter|litre)/i, unit: 'l' },
  { regex: /(\d+(?:\.\d+)?)\s*grams?\b/i, unit: 'g' },
  { regex: /(\d+(?:\.\d+)?)\s*g\b/i, unit: 'g' },
  { regex: /(\d+(?:\.\d+)?)\s*kg\b/i, unit: 'kg' },
  { regex: /(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\b/i, unit: 'lb' },
  { regex: /(\d+(?:\.\d+)?)\s*(?:capsules|caps)\b/i, unit: 'caps' },
  { regex: /(\d+(?:\.\d+)?)\s*(?:tablets|tabs)\b/i, unit: 'tablets' },
  { regex: /(\d+(?:\.\d+)?)\s*(?:ct|count)\b/i, unit: 'ct' },
];

export function extractSize(text: string): { value: number; unit: SizeUnit } | null {
  // Try each pattern; fl oz must come before oz (it does by array order)
  let earliest: { value: number; unit: SizeUnit; index: number } | null = null;

  for (const { regex, unit } of SIZE_PATTERNS) {
    const m = regex.exec(text);
    if (m) {
      const idx = m.index;
      if (earliest === null || idx < earliest.index) {
        earliest = { value: parseFloat(m[1]), unit, index: idx };
      }
    }
  }

  // For "ct"/"count" matches we need to make sure they aren't pack-count patterns
  // Actually the spec says return the FIRST valid size found, so we keep as-is.
  // But we need to avoid matching "count" in "2 count" when it's a pack context.
  // The spec says extractSize should just extract sizes, and extractPackCount handles packs.
  // "60ct" → size, "2 count" followed by "pack" → pack. But extractSize doesn't care about packs.

  if (earliest === null) return null;
  return { value: earliest.value, unit: earliest.unit };
}

const PACK_PATTERNS: { regex: RegExp; groupIndex: number }[] = [
  { regex: /(\d+)\s*[-]?\s*pack\b/i, groupIndex: 1 },
  { regex: /(\d+)\s*pk\b/i, groupIndex: 1 },
  { regex: /pack\s+of\s+(\d+)/i, groupIndex: 1 },
  { regex: /bundle\s+of\s+(\d+)/i, groupIndex: 1 },
  { regex: /set\s+of\s+(\d+)/i, groupIndex: 1 },
  { regex: /\bx\s*(\d+)\b/i, groupIndex: 1 },
  { regex: /\b(\d+)\s*x\b/i, groupIndex: 1 },
  { regex: /twin\s+pack/i, groupIndex: -1 },   // → 2
  { regex: /triple\s+pack/i, groupIndex: -1 },  // → 3
];

export function extractPackCount(text: string): number {
  // Check named packs first
  if (/twin\s+pack/i.test(text)) return 2;
  if (/triple\s+pack/i.test(text)) return 3;

  for (const { regex, groupIndex } of PACK_PATTERNS) {
    if (groupIndex === -1) continue; // already handled above
    const m = regex.exec(text);
    if (m) {
      return parseInt(m[groupIndex], 10);
    }
  }

  return 1;
}

export function normalizeCondition(raw: string): CanonicalIdentity['condition'] {
  const lower = (raw ?? '').trim().toLowerCase().replace(/[_-]/g, ' ');

  if (/^(new|brand new|new with tags|new with box|new other)$/i.test(lower) || lower === '') {
    return 'new';
  }
  if (/open\s*box/.test(lower)) {
    return 'open-box';
  }
  if (/^(used|pre\s*owned|good|very good|acceptable)$/.test(lower)) {
    return 'used';
  }
  if (/for\s*parts|salvage/.test(lower)) {
    return 'for-parts';
  }

  return 'new';
}

const CORPORATE_SUFFIXES = [
  ', Inc.',
  ', Inc',
  ', LLC',
  ', Co.',
  ', Co',
  ' Inc.',
  ' Inc',
  ' LLC',
  ' Corp.',
  ' Corp',
  ' Co.',
  ' Co',
  ' Ltd.',
  ' Ltd',
  ' International',
];

export function normalizeBrand(brand: string): string {
  let b = brand.trim().toLowerCase();
  // Remove corporate suffixes (try longest first for safety; they're ordered with comma variants first)
  for (const suffix of CORPORATE_SUFFIXES) {
    const suf = suffix.toLowerCase();
    if (b.endsWith(suf)) {
      b = b.slice(0, b.length - suf.length);
      break;
    }
  }
  // Remove trailing punctuation
  b = b.replace(/[,.\s]+$/, '');
  return b;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'by',
  'of', 'in', 'to', 'is', 'it', 'its', 'this', 'that',
]);

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = lower.split(/[\s\-_\/]+/).filter(Boolean);
  const filtered = tokens.filter(t => {
    if (STOPWORDS.has(t)) return false;
    if (/^\d+$/.test(t)) return false;
    if (t.length <= 1) return false;
    return true;
  });
  const unique = [...new Set(filtered)];
  unique.sort();
  return unique;
}

// Patterns to strip from product name to get the "core" product line
const SIZE_STRIP_RE = /\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|oz|ml|l\b|liter|litre|grams?|g\b|kg|lbs?|pounds?|capsules|caps|tablets|tabs|ct|count)\b/gi;
const PACK_STRIP_RE = /\d+\s*[-]?\s*pack\b|\d+\s*pk\b|pack\s+of\s+\d+|bundle\s+of\s+\d+|set\s+of\s+\d+|\bx\s*\d+\b|\b\d+\s*x\b|twin\s+pack|triple\s+pack/gi;

export function buildIdentity(params: {
  brand: string;
  productName: string;
  upc?: string;
  mpn?: string;
  condition?: string;
  packCount?: number;
  variant?: string;
}): CanonicalIdentity {
  const brand = normalizeBrand(params.brand);

  // Strip size and pack patterns from product name for productLine
  let productLine = params.productName.toLowerCase();
  productLine = productLine.replace(SIZE_STRIP_RE, '');
  productLine = productLine.replace(PACK_STRIP_RE, '');
  productLine = productLine.replace(/\s+/g, ' ').trim();

  const variant = params.variant ?? null;
  const size = extractSize(params.productName);
  const packCount = params.packCount ?? extractPackCount(params.productName);
  const condition = normalizeCondition(params.condition ?? 'new');
  const upc = params.upc ?? null;
  const mpn = params.mpn ?? null;
  const keywords = tokenize(params.productName);

  const hashPayload = JSON.stringify({ brand, productLine, variant, size, packCount, condition, upc });
  const identityHash = createHash('sha256').update(hashPayload).digest('hex');

  return {
    brand,
    productLine,
    variant,
    size,
    packCount,
    condition,
    upc,
    mpn,
    keywords,
    identityHash,
  };
}
