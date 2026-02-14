import {
  matchComps,
  filterMatches,
  filterMatchesAndAmbiguous,
  CompCandidate,
  BUNDLE_INDICATORS,
} from '../../../src/lib/pricing/comp-matcher.js';
import { buildIdentity } from '../../../src/lib/pricing/identity-model.js';

function makeCandidate(overrides: Partial<CompCandidate> & { id: string; title: string }): CompCandidate {
  return {
    condition: 'New',
    priceCents: 1500,
    shippingCents: 0,
    deliveredCents: 1500,
    ...overrides,
  };
}

describe('matchComps', () => {
  it('should match an exact candidate', () => {
    const identity = buildIdentity({
      brand: 'Moon Brew',
      productName: 'Sleepytime Elixir 8 fl oz',
    });
    const candidate = makeCandidate({
      id: '1',
      title: 'Moon Brew Sleepytime Elixir 8 fl oz New',
      condition: 'New',
    });
    const [result] = matchComps(identity, [candidate]);
    expect(result.verdict).toBe('match');
  });

  it('should reject on condition mismatch', () => {
    const identity = buildIdentity({
      brand: 'Moon Brew',
      productName: 'Sleepytime Elixir 8 fl oz',
      condition: 'new',
    });
    const candidate = makeCandidate({
      id: '2',
      title: 'Moon Brew Sleepytime Elixir 8 fl oz',
      condition: 'Pre-Owned',
    });
    const [result] = matchComps(identity, [candidate]);
    expect(result.verdict).toBe('reject');
    expect(result.reasons.some(r => r.includes('condition mismatch'))).toBe(true);
  });

  it('should reject on pack count mismatch', () => {
    const identity = buildIdentity({
      brand: 'Moon Brew',
      productName: 'Sleepytime Elixir 8 fl oz',
    });
    const candidate = makeCandidate({
      id: '3',
      title: 'Moon Brew Sleepytime Elixir 8 fl oz 3-pack',
    });
    const [result] = matchComps(identity, [candidate]);
    expect(result.verdict).toBe('reject');
    expect(result.reasons.some(r => r.includes('packCount mismatch'))).toBe(true);
  });

  it('should reject on size mismatch', () => {
    const identity = buildIdentity({
      brand: 'Moon Brew',
      productName: 'Sleepytime Elixir 8 oz',
    });
    const candidate = makeCandidate({
      id: '4',
      title: 'Moon Brew Sleepytime Elixir 16 oz',
    });
    const [result] = matchComps(identity, [candidate]);
    expect(result.verdict).toBe('reject');
    expect(result.reasons.some(r => r.includes('size mismatch'))).toBe(true);
  });

  it('should accept size within tolerance (8 vs 8.2 oz = 2.5%)', () => {
    const identity = buildIdentity({
      brand: 'Moon Brew',
      productName: 'Sleepytime Elixir 8 oz',
    });
    const candidate = makeCandidate({
      id: '5',
      title: 'Moon Brew Sleepytime Elixir 8.2 oz',
    });
    const [result] = matchComps(identity, [candidate]);
    expect(result.reasons.some(r => r.includes('size mismatch'))).toBe(false);
    expect(result.reasons.some(r => r.includes('size match'))).toBe(true);
  });

  it('should reject on bundle indicator when packCount=1', () => {
    const identity = buildIdentity({
      brand: 'Moon Brew',
      productName: 'Sleepytime Elixir 8 oz',
    });
    const candidate = makeCandidate({
      id: '6',
      title: 'Moon Brew Sleepytime Lot of 5',
    });
    const [result] = matchComps(identity, [candidate]);
    expect(result.verdict).toBe('reject');
    expect(result.reasons.some(r => r.includes('bundle indicator'))).toBe(true);
  });

  it('should reject when brand not found in title', () => {
    const identity = buildIdentity({
      brand: 'Moon Brew',
      productName: 'Sleepytime Elixir 8 oz',
    });
    const candidate = makeCandidate({
      id: '7',
      title: 'Celestial Sleepytime Tea 8 oz',
    });
    const [result] = matchComps(identity, [candidate]);
    expect(result.verdict).toBe('reject');
    expect(result.reasons.some(r => r.includes('brand not found'))).toBe(true);
  });

  it('should reject or mark ambiguous on insufficient token overlap', () => {
    const identity = buildIdentity({
      brand: 'Moon Brew',
      productName: 'Sleepytime Elixir',
    });
    const candidate = makeCandidate({
      id: '8',
      title: 'Moon Brew Daily Vitamin',
    });
    const [result] = matchComps(identity, [candidate]);
    expect(['reject', 'ambiguous']).toContain(result.verdict);
  });

  it('should be ambiguous when brand and tokens match but size is unknown', () => {
    const identity = buildIdentity({
      brand: 'Moon Brew',
      productName: 'Sleepytime Elixir 8 oz',
    });
    const candidate = makeCandidate({
      id: '9',
      title: 'Moon Brew Sleepytime Elixir Premium',
    });
    const [result] = matchComps(identity, [candidate]);
    expect(result.verdict).toBe('ambiguous');
  });

  it('should handle multiple candidates with mixed verdicts', () => {
    const identity = buildIdentity({
      brand: 'Moon Brew',
      productName: 'Sleepytime Elixir 8 fl oz',
    });
    const candidates = [
      makeCandidate({ id: 'a', title: 'Moon Brew Sleepytime Elixir 8 fl oz New' }),
      makeCandidate({ id: 'b', title: 'Moon Brew Sleepytime Elixir 8 fl oz', condition: 'Used' }),
      makeCandidate({ id: 'c', title: 'Moon Brew Sleepytime Elixir 16 fl oz' }),
      makeCandidate({ id: 'd', title: 'Moon Brew Sleepytime Elixir Premium' }),
      makeCandidate({ id: 'e', title: 'Totally Different Brand Product 8 oz' }),
    ];
    const results = matchComps(identity, candidates);
    expect(results).toHaveLength(5);

    const matchCount = results.filter(r => r.verdict === 'match').length;
    const rejectCount = results.filter(r => r.verdict === 'reject').length;
    const ambiguousCount = results.filter(r => r.verdict === 'ambiguous').length;

    expect(matchCount).toBeGreaterThanOrEqual(1);
    expect(rejectCount).toBeGreaterThanOrEqual(2);
    expect(matchCount + rejectCount + ambiguousCount).toBe(5);
  });
});

describe('filterMatches', () => {
  it('should return only match verdicts', () => {
    const identity = buildIdentity({
      brand: 'Moon Brew',
      productName: 'Sleepytime Elixir 8 fl oz',
    });
    const candidates = [
      makeCandidate({ id: 'a', title: 'Moon Brew Sleepytime Elixir 8 fl oz New' }),
      makeCandidate({ id: 'b', title: 'Moon Brew Sleepytime Elixir 8 fl oz', condition: 'Used' }),
      makeCandidate({ id: 'c', title: 'Moon Brew Sleepytime Elixir Premium' }),
    ];
    const results = matchComps(identity, candidates);
    const matches = filterMatches(results);
    expect(matches.every(r => r.verdict === 'match')).toBe(true);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});

describe('filterMatchesAndAmbiguous', () => {
  it('should exclude only reject verdicts', () => {
    const identity = buildIdentity({
      brand: 'Moon Brew',
      productName: 'Sleepytime Elixir 8 fl oz',
    });
    const candidates = [
      makeCandidate({ id: 'a', title: 'Moon Brew Sleepytime Elixir 8 fl oz New' }),
      makeCandidate({ id: 'b', title: 'Moon Brew Sleepytime Elixir 8 fl oz', condition: 'Used' }),
      makeCandidate({ id: 'c', title: 'Moon Brew Sleepytime Elixir Premium' }),
    ];
    const results = matchComps(identity, candidates);
    const nonReject = filterMatchesAndAmbiguous(results);
    expect(nonReject.every(r => r.verdict !== 'reject')).toBe(true);
    // The rejected condition-mismatch one should be excluded
    expect(nonReject.length).toBeLessThan(results.length);
  });
});
