import {
  extractSize,
  extractPackCount,
  normalizeCondition,
  normalizeBrand,
  tokenize,
  buildIdentity,
} from '../../../src/lib/pricing/identity-model.js';

describe('extractSize', () => {
  it('should parse "60ct" from vitamin title', () => {
    expect(extractSize("Nature's Bounty Fish Oil 1200mg 60ct")).toEqual({ value: 60, unit: 'ct' });
  });

  it('should parse "16 fl oz"', () => {
    expect(extractSize('CeraVe Moisturizer 16 fl oz')).toEqual({ value: 16, unit: 'fl oz' });
  });

  it('should parse "2.5 lb"', () => {
    expect(extractSize('Protein Powder 2.5 lb')).toEqual({ value: 2.5, unit: 'lb' });
  });

  it('should parse "120 capsules" as caps', () => {
    expect(extractSize('Vitamin D3 5000IU 120 capsules')).toEqual({ value: 120, unit: 'caps' });
  });

  it('should return null when no size present', () => {
    expect(extractSize('Random Product No Size')).toBeNull();
  });

  it('should parse "500ml"', () => {
    expect(extractSize('Shampoo 500ml Professional')).toEqual({ value: 500, unit: 'ml' });
  });

  it('should parse "1 L"', () => {
    expect(extractSize('Body Wash 1 L large')).toEqual({ value: 1, unit: 'l' });
  });

  it('should parse "100g"', () => {
    expect(extractSize('Supplements 100g powder')).toEqual({ value: 100, unit: 'g' });
  });
});

describe('extractPackCount', () => {
  it('should parse "2 Pack"', () => {
    expect(extractPackCount("2 Pack Nature's Bounty")).toBe(2);
  });

  it('should parse "pack of 3"', () => {
    expect(extractPackCount('pack of 3 vitamins')).toBe(3);
  });

  it('should parse "bundle of 4"', () => {
    expect(extractPackCount('bundle of 4')).toBe(4);
  });

  it('should return 1 for "single bottle"', () => {
    expect(extractPackCount('single bottle')).toBe(1);
  });

  it('should parse "3-pack"', () => {
    expect(extractPackCount('3-pack CeraVe')).toBe(3);
  });

  it('should NOT treat "60ct" as a pack count', () => {
    expect(extractPackCount('Vitamins 60ct')).toBe(1);
  });

  it('should parse "twin pack"', () => {
    expect(extractPackCount('twin pack lotion')).toBe(2);
  });
});

describe('normalizeCondition', () => {
  it('should normalize "Brand New" to new', () => {
    expect(normalizeCondition('Brand New')).toBe('new');
  });

  it('should normalize "Pre-Owned" to used', () => {
    expect(normalizeCondition('Pre-Owned')).toBe('used');
  });

  it('should normalize "Open Box" to open-box', () => {
    expect(normalizeCondition('Open Box')).toBe('open-box');
  });

  it('should normalize "For Parts" to for-parts', () => {
    expect(normalizeCondition('For Parts')).toBe('for-parts');
  });

  it('should normalize "USED" to used', () => {
    expect(normalizeCondition('USED')).toBe('used');
  });

  it('should default to new for empty string', () => {
    expect(normalizeCondition('')).toBe('new');
  });
});

describe('normalizeBrand', () => {
  it('should strip "NIKE, Inc." to "nike"', () => {
    expect(normalizeBrand('NIKE, Inc.')).toBe('nike');
  });

  it('should preserve apostrophes', () => {
    expect(normalizeBrand("Nature's Bounty")).toBe("nature's bounty");
  });

  it('should trim whitespace', () => {
    expect(normalizeBrand('  CeraVe  ')).toBe('cerave');
  });

  it('should strip "Apple Inc" to "apple"', () => {
    expect(normalizeBrand('Apple Inc')).toBe('apple');
  });
});

describe('tokenize', () => {
  it('should lowercase, sort, remove stopwords and single chars', () => {
    expect(tokenize('The Quick Brown Fox')).toEqual(['brown', 'fox', 'quick']);
  });

  it('should split on hyphens', () => {
    expect(tokenize('Nature-Based Supplement')).toEqual(['based', 'nature', 'supplement']);
  });

  it('should return empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('buildIdentity', () => {
  it('should build identity with size, packCount, and brand normalization', () => {
    const identity = buildIdentity({
      brand: 'Moon Brew',
      productName: 'Sleepytime Elixir 8 fl oz 2-pack',
    });

    expect(identity.brand).toBe('moon brew');
    expect(identity.size).toEqual({ value: 8, unit: 'fl oz' });
    expect(identity.packCount).toBe(2);
    expect(typeof identity.identityHash).toBe('string');
    expect(identity.identityHash.length).toBe(64); // SHA-256 hex
  });

  it('should produce deterministic hashes for same inputs', () => {
    const a = buildIdentity({ brand: 'Moon Brew', productName: 'Sleepytime Elixir 8 fl oz' });
    const b = buildIdentity({ brand: 'Moon Brew', productName: 'Sleepytime Elixir 8 fl oz' });
    expect(a.identityHash).toBe(b.identityHash);
  });

  it('should produce different hashes for different inputs', () => {
    const a = buildIdentity({ brand: 'Moon Brew', productName: 'Sleepytime Elixir 8 fl oz' });
    const b = buildIdentity({ brand: 'Moon Brew', productName: 'Daytime Elixir 16 fl oz' });
    expect(a.identityHash).not.toBe(b.identityHash);
  });
});
