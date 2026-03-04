/**
 * Chunk 5 — SERP Fallback unit tests.
 *
 * Tests:
 *  A) serpFallbackLookup module behaviour (quota, network, parsing)
 *  B) shouldUseSerpFallback decision helper
 *  C) Serp candidates still go through identity filtering (strictMatchIdentity)
 *  D) Integration guard: serp not called when sold is strong
 */

// ─── Mock price-quota before any imports ─────────────────────────────────────

jest.mock('../../../src/lib/price-quota.js', () => ({
  canUseSerp: jest.fn(),
  incSerp:    jest.fn().mockResolvedValue(undefined),
}));

import { canUseSerp, incSerp } from '../../../src/lib/price-quota.js';
import {
  serpFallbackLookup,
  shouldUseSerpFallback,
  type SerpCandidate,
} from '../../../src/lib/pricing/serp-fallback.js';
import { extractIdentity } from '../../../src/lib/pricing/identity-model.js';
import { strictMatchIdentity } from '../../../src/lib/pricing/comp-matcher.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockCanUseSerp = canUseSerp as jest.MockedFunction<typeof canUseSerp>;
const mockIncSerp    = incSerp    as jest.MockedFunction<typeof incSerp>;

function mockFetch(status: number, body: unknown): void {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

function makeSerpItems(count: number, priceEach = 19.99, title = 'Brand X Product 90ct'): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    title: `${title} #${i + 1}`,
    extracted_price: priceEach,
    shipping: 'Free shipping',
  }));
}

// ─── A: serpFallbackLookup module tests ──────────────────────────────────────

describe('serpFallbackLookup', () => {
  const ORIGINAL_KEY = process.env.SERPAPI_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    process.env.SERPAPI_KEY = 'test-key-abc123';
    mockCanUseSerp.mockResolvedValue(true);
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env.SERPAPI_KEY;
    } else {
      process.env.SERPAPI_KEY = ORIGINAL_KEY;
    }
  });

  it('returns skipped:true when SERPAPI_KEY is absent — no network call', async () => {
    delete process.env.SERPAPI_KEY;
    const result = await serpFallbackLookup('Brand X 90ct Vitamin C');
    expect(result.skipped).toBe(true);
    expect(result.candidates).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns quotaExceeded:true when canUseSerp returns false', async () => {
    mockCanUseSerp.mockResolvedValue(false);
    mockFetch(200, { organic_results: [] }); // should not be called
    const result = await serpFallbackLookup('query');
    expect(result.quotaExceeded).toBe(true);
    expect(result.candidates).toHaveLength(0);
  });

  it('returns empty when fetch throws (network error)', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network failure'));
    const result = await serpFallbackLookup('query');
    expect(result.candidates).toHaveLength(0);
    expect(result.skipped).toBe(false);
    expect(result.quotaExceeded).toBe(false);
  });

  it('returns empty when SerpAPI returns HTTP 429', async () => {
    mockFetch(429, { error: 'rate limited' });
    const result = await serpFallbackLookup('query');
    expect(result.candidates).toHaveLength(0);
  });

  it('returns empty when organic_results is absent or empty', async () => {
    mockFetch(200, { organic_results: [] });
    const result = await serpFallbackLookup('query');
    expect(result.candidates).toHaveLength(0);
  });

  it('parses extracted_price correctly', async () => {
    mockFetch(200, {
      organic_results: [
        { title: 'Brand X 90ct', extracted_price: 18.99, shipping: 'Free shipping' },
      ],
    });
    const result = await serpFallbackLookup('Brand X 90ct');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].priceCents).toBe(1899);
    expect(result.candidates[0].shipCents).toBe(0);
    expect(result.candidates[0].source).toBe('serp');
  });

  it('parses nested price object (price.extracted_value)', async () => {
    mockFetch(200, {
      organic_results: [
        { title: 'Brand X 90ct', price: { extracted_value: 22.50 } },
      ],
    });
    const result = await serpFallbackLookup('query');
    expect(result.candidates[0].priceCents).toBe(2250);
  });

  it('parses numeric shipping correctly', async () => {
    mockFetch(200, {
      organic_results: [
        { title: 'Brand X 90ct', extracted_price: 15.00, shipping: '$4.99 shipping' },
      ],
    });
    const result = await serpFallbackLookup('query');
    expect(result.candidates[0].priceCents).toBe(1500);
    expect(result.candidates[0].shipCents).toBe(499);
  });

  it('skips items with no price', async () => {
    mockFetch(200, {
      organic_results: [
        { title: 'No price item' },                            // no price → skip
        { title: 'Brand X 90ct', extracted_price: 19.99 },   // has price → keep
      ],
    });
    const result = await serpFallbackLookup('query');
    expect(result.candidates).toHaveLength(1);
  });

  it('skips items with no title', async () => {
    mockFetch(200, {
      organic_results: [
        { extracted_price: 19.99 },  // no title → skip
      ],
    });
    const result = await serpFallbackLookup('query');
    expect(result.candidates).toHaveLength(0);
  });

  it('calls incSerp after successful HTTP response', async () => {
    mockFetch(200, { organic_results: makeSerpItems(3) });
    await serpFallbackLookup('query');
    expect(mockIncSerp).toHaveBeenCalledTimes(1);
  });

  it('does NOT call incSerp when HTTP error occurs', async () => {
    mockFetch(429, { error: 'rate limit' });
    await serpFallbackLookup('query');
    expect(mockIncSerp).not.toHaveBeenCalled();
  });

  it('does NOT call incSerp when quota already exceeded', async () => {
    mockCanUseSerp.mockResolvedValue(false);
    await serpFallbackLookup('query');
    expect(mockIncSerp).not.toHaveBeenCalled();
  });

  it('fail-opens on canUseSerp error and proceeds with fetch', async () => {
    mockCanUseSerp.mockRejectedValue(new Error('redis down'));
    mockFetch(200, {
      organic_results: [{ title: 'Brand X 90ct', extracted_price: 20.00 }],
    });
    const result = await serpFallbackLookup('query');
    // Should still return candidate (fail-open)
    expect(result.candidates).toHaveLength(1);
    expect(result.quotaExceeded).toBe(false);
  });
});

// ─── B: shouldUseSerpFallback decision helper ────────────────────────────────

describe('shouldUseSerpFallback', () => {
  it('returns true when soldCleanCount=0 and activeCount=0', () => {
    expect(shouldUseSerpFallback(0, 0)).toBe(true);
  });

  it('returns true when soldCleanCount=9 and activeCount=4', () => {
    expect(shouldUseSerpFallback(9, 4)).toBe(true);
  });

  it('returns true when soldCleanCount=0 and activeCount=4', () => {
    expect(shouldUseSerpFallback(0, 4)).toBe(true);
  });

  it('returns false when soldCleanCount >= 10 (sold strong — never call serp)', () => {
    expect(shouldUseSerpFallback(10, 0)).toBe(false);
    expect(shouldUseSerpFallback(12, 0)).toBe(false);
    expect(shouldUseSerpFallback(25, 0)).toBe(false);
  });

  it('returns false when activeCount >= 5, even with weak sold data', () => {
    expect(shouldUseSerpFallback(3, 5)).toBe(false);
    expect(shouldUseSerpFallback(0, 10)).toBe(false);
  });

  it('boundary: soldCleanCount=9, activeCount=5 → false (active is sufficient)', () => {
    expect(shouldUseSerpFallback(9, 5)).toBe(false);
  });

  it('boundary: soldCleanCount=10, activeCount=0 → false (sold takes over)', () => {
    expect(shouldUseSerpFallback(10, 0)).toBe(false);
  });
});

// ─── C: Serp candidates go through identity filtering ────────────────────────

describe('serp candidates + identity filtering', () => {
  /**
   * Simulates what delivered-pricing does: extract identity from query then
   * filter serp candidates through strictMatchIdentity before using them.
   */
  function filterSerpCandidates(queryText: string, candidates: SerpCandidate[]): SerpCandidate[] {
    const queryIdentity = extractIdentity(queryText);
    return candidates.filter(c => {
      const { pass } = strictMatchIdentity(queryIdentity, c.title);
      return pass;
    });
  }

  it('rejects wrong-count serp comps', () => {
    const query = 'Brand X Vitamin C 90ct';
    const candidates: SerpCandidate[] = [
      { title: 'Brand X Vitamin C 30ct',  priceCents: 1500, shipCents: 0, source: 'serp' },
      { title: 'Brand X Vitamin C 60ct',  priceCents: 1800, shipCents: 0, source: 'serp' },
      { title: 'Brand X Vitamin C 90ct',  priceCents: 2200, shipCents: 0, source: 'serp' }, // ✓
      { title: 'Brand X Vitamin C 90 count', priceCents: 2000, shipCents: 0, source: 'serp' }, // ✓
    ];
    const kept = filterSerpCandidates(query, candidates);
    expect(kept).toHaveLength(2);
    expect(kept.every(c => c.title.includes('90'))).toBe(true);
  });

  it('rejects wrong-strength serp comps', () => {
    const query = 'Vitamin B12 1000mcg 60ct';
    const candidates: SerpCandidate[] = [
      { title: 'Vitamin B12 500mcg 60ct',  priceCents: 1200, shipCents: 0, source: 'serp' }, // ✗
      { title: 'Vitamin B12 1000mcg 60ct', priceCents: 1800, shipCents: 0, source: 'serp' }, // ✓
    ];
    const kept = filterSerpCandidates(query, candidates);
    expect(kept).toHaveLength(1);
    expect(kept[0].priceCents).toBe(1800);
  });

  it('allows comps with no variant signals (benefit of doubt)', () => {
    const query = 'Brand X Shampoo 90ct';
    const candidates: SerpCandidate[] = [
      { title: 'Brand X Shampoo', priceCents: 1500, shipCents: 0, source: 'serp' }, // null count → pass
    ];
    const kept = filterSerpCandidates(query, candidates);
    expect(kept).toHaveLength(1);
  });

  it('mixed batch: rejects mismatches, keeps good matches', () => {
    const query = 'Probiotic 50 Billion CFU 30ct';
    const candidates: SerpCandidate[] = [
      { title: 'Probiotic 10 Billion CFU 30ct',  priceCents: 1000, shipCents: 0, source: 'serp' }, // ✗ CFU
      { title: 'Probiotic 50 Billion CFU 30ct',  priceCents: 2000, shipCents: 0, source: 'serp' }, // ✓
      { title: 'Probiotic 50 Billion CFU 60ct',  priceCents: 3500, shipCents: 0, source: 'serp' }, // ✗ count
      { title: 'Probiotic 50B CFU supplement',   priceCents: 1900, shipCents: 0, source: 'serp' }, // ✓ (no count)
    ];
    const kept = filterSerpCandidates(query, candidates);
    expect(kept).toHaveLength(2);
    expect(kept.map(c => c.priceCents)).toEqual(expect.arrayContaining([2000, 1900]));
  });
});

// ─── D: Guard tests — serp not called when sold is strong ────────────────────

describe('serp guard: sold-strong check using shouldUseSerpFallback', () => {
  it('12 sold comps → should NOT trigger serp (soldCleanCount >= 10)', () => {
    // soldCleanCount=12 exceeds threshold → guard returns false
    expect(shouldUseSerpFallback(12, 3)).toBe(false);
  });

  it('8 sold comps, 3 active → SHOULD trigger serp (soldWeak + sparse active)', () => {
    expect(shouldUseSerpFallback(8, 3)).toBe(true);
  });

  it('0 sold comps, 0 active → SHOULD trigger serp', () => {
    expect(shouldUseSerpFallback(0, 0)).toBe(true);
  });
});
