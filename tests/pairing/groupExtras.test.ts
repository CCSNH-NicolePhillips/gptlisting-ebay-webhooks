// tests/pairing/groupExtras.test.ts
import { groupExtrasWithProducts } from '../../src/pairing/groupExtras';
import type { Pair } from '../../src/pairing/schema';
import type { FeatureRow, Role } from '../../src/pairing/featurePrep';

// Helper to create valid Pair objects with required fields
function createPair(overrides: Partial<Pair>): Pair {
  return {
    frontUrl: 'https://example.com/front.jpg',
    backUrl: 'https://example.com/back.jpg',
    brand: 'TestBrand',
    product: 'Test Product',
    variant: null,
    matchScore: 0.95,
    confidence: 0.9,
    evidence: [],
    sizeFront: null,
    sizeBack: null,
    ...overrides
  };
}

// Helper to create valid FeatureRow objects with required fields
function createFeature(overrides: Partial<FeatureRow>): FeatureRow {
  return {
    url: 'https://example.com/image.jpg',
    role: 'front' as Role,
    brandNorm: null as any,
    productTokens: [],
    variantTokens: [],
    sizeCanonical: null,
    packagingHint: 'other',
    categoryPath: null,
    categoryTail: '',
    hasText: false,
    colorKey: '',
    textExtracted: '',
    ...overrides
  };
}

describe('groupExtrasWithProducts', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should create product groups from pairs', () => {
    const pairs: Pair[] = [
      createPair({
        frontUrl: 'https://example.com/front1.jpg',
        backUrl: 'https://example.com/back1.jpg',
        evidence: ['brandMatch', 'productMatch'],
      }),
    ];

    const features = new Map<string, FeatureRow>([
      ['https://example.com/front1.jpg', createFeature({
        url: 'https://example.com/front1.jpg',
        role: 'front',
        brandNorm: 'testbrand',
        packagingHint: 'bottle',
        categoryTail: 'Health & Beauty',
      })],
      ['https://example.com/back1.jpg', createFeature({
        url: 'https://example.com/back1.jpg',
        role: 'back',
        brandNorm: 'testbrand',
        packagingHint: 'bottle',
        categoryTail: 'Health & Beauty',
      })],
    ]);

    const result = groupExtrasWithProducts(pairs, features);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      productId: expect.stringContaining('testbrand'),
      frontUrl: 'https://example.com/front1.jpg',
      backUrl: 'https://example.com/back1.jpg',
      extras: [],
      evidence: {
        brand: 'TestBrand',
        product: 'Test Product',
        variant: null,
        matchScore: 0.95,
        confidence: 0.9,
        triggers: ['brandMatch', 'productMatch'],
      },
    });
  });

  it('should attach extras with brand match', () => {
    const pairs: Pair[] = [createPair({
      frontUrl: 'https://example.com/front1.jpg',
      backUrl: 'https://example.com/back1.jpg',
    })];

    const features = new Map<string, FeatureRow>([
      ['https://example.com/front1.jpg', createFeature({ url: 'https://example.com/front1.jpg', role: 'front', brandNorm: 'testbrand', packagingHint: 'bottle', categoryTail: 'Health' })],
      ['https://example.com/back1.jpg', createFeature({ url: 'https://example.com/back1.jpg', role: 'back', brandNorm: 'testbrand', packagingHint: 'bottle', categoryTail: 'Health' })],
      ['https://example.com/side1.jpg', createFeature({ url: 'https://example.com/side1.jpg', role: 'side', brandNorm: 'testbrand', packagingHint: 'bottle', categoryTail: 'Health' })],
    ]);

    const result = groupExtrasWithProducts(pairs, features);
    expect(result[0].extras).toContain('https://example.com/side1.jpg');
  });

  it('should attach extras with packaging match', () => {
    const pairs: Pair[] = [createPair({})];
    const features = new Map<string, FeatureRow>([
      ['https://example.com/front.jpg', createFeature({ url: 'https://example.com/front.jpg', role: 'front', packagingHint: 'jar', categoryTail: 'Health' })],
      ['https://example.com/back.jpg', createFeature({ url: 'https://example.com/back.jpg', role: 'back', packagingHint: 'jar', categoryTail: 'Health' })],
      ['https://example.com/side.jpg', createFeature({ url: 'https://example.com/side.jpg', role: 'side', packagingHint: 'jar', categoryTail: 'Health' })],
    ]);
    const result = groupExtrasWithProducts(pairs, features);
    expect(result[0].extras).toContain('https://example.com/side.jpg');
  });

  it('should attach extras with category match', () => {
    const pairs: Pair[] = [createPair({})];
    const features = new Map<string, FeatureRow>([
      ['https://example.com/front.jpg', createFeature({ url: 'https://example.com/front.jpg', role: 'front', categoryTail: 'Vitamins Supplements' })],
      ['https://example.com/back.jpg', createFeature({ url: 'https://example.com/back.jpg', role: 'back', categoryTail: 'Vitamins Supplements' })],
      ['https://example.com/side.jpg', createFeature({ url: 'https://example.com/side.jpg', role: 'side', categoryTail: 'Supplements Health', brandNorm: 'different' })],
    ]);
    const result = groupExtrasWithProducts(pairs, features);
    expect(result[0].extras).toContain('https://example.com/side.jpg');
  });

  it('should reject extras with brand mismatch', () => {
    const pairs: Pair[] = [createPair({ brand: 'BrandA' })];
    const features = new Map<string, FeatureRow>([
      ['https://example.com/front.jpg', createFeature({ role: 'front', brandNorm: 'branda' })],
      ['https://example.com/back.jpg', createFeature({ role: 'back', brandNorm: 'branda' })],
      ['https://example.com/side.jpg', createFeature({ role: 'side', brandNorm: 'brandb' })],
    ]);
    const result = groupExtrasWithProducts(pairs, features);
    expect(result[0].extras).toHaveLength(0);
  });

  it('should require minimum score of 2 for attachment', () => {
    const pairs: Pair[] = [createPair({})];
    const features = new Map<string, FeatureRow>([
      ['https://example.com/front.jpg', createFeature({ role: 'front', categoryTail: 'A' })],
      ['https://example.com/back.jpg', createFeature({ role: 'back', categoryTail: 'B' })],
      ['https://example.com/side.jpg', createFeature({ url: 'https://example.com/folder2/side.jpg', role: 'side', categoryTail: 'C' })],
    ]);
    const result = groupExtrasWithProducts(pairs, features);
    expect(result[0].extras).toHaveLength(0);
  });

  it('should limit extras per product to maxExtrasPerProduct', () => {
    const pairs: Pair[] = [createPair({})];
    const features = new Map<string, FeatureRow>([
      ['https://example.com/front.jpg', createFeature({ role: 'front', brandNorm: 'testbrand' })],
      ['https://example.com/back.jpg', createFeature({ role: 'back', brandNorm: 'testbrand' })],
      ['https://example.com/side1.jpg', createFeature({ url: 'https://example.com/side1.jpg', role: 'side', brandNorm: 'testbrand' })],
      ['https://example.com/side2.jpg', createFeature({ url: 'https://example.com/side2.jpg', role: 'side', brandNorm: 'testbrand' })],
      ['https://example.com/side3.jpg', createFeature({ url: 'https://example.com/side3.jpg', role: 'side', brandNorm: 'testbrand' })],
    ]);
    const result = groupExtrasWithProducts(pairs, features, 2);
    expect(result[0].extras).toHaveLength(2);
  });

  it('should not reuse extras across products', () => {
    const pairs: Pair[] = [
      createPair({ brand: 'BrandA', product: 'Product A' }),
      createPair({ frontUrl: 'https://example.com/front2.jpg', backUrl: 'https://example.com/back2.jpg', brand: 'BrandA', product: 'Product B' }),
    ];
    const features = new Map<string, FeatureRow>([
      ['https://example.com/front.jpg', createFeature({ role: 'front', brandNorm: 'branda' })],
      ['https://example.com/back.jpg', createFeature({ role: 'back', brandNorm: 'branda' })],
      ['https://example.com/front2.jpg', createFeature({ url: 'https://example.com/front2.jpg', role: 'front', brandNorm: 'branda' })],
      ['https://example.com/back2.jpg', createFeature({ url: 'https://example.com/back2.jpg', role: 'back', brandNorm: 'branda' })],
      ['https://example.com/side.jpg', createFeature({ url: 'https://example.com/side.jpg', role: 'side', brandNorm: 'branda' })],
    ]);
    const result = groupExtrasWithProducts(pairs, features);
    expect(result).toHaveLength(2);
    expect(result[0].extras).toContain('https://example.com/side.jpg');
    expect(result[1].extras).not.toContain('https://example.com/side.jpg');
  });

  it('should handle empty pairs array', () => {
    const result = groupExtrasWithProducts([], new Map());
    expect(result).toHaveLength(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('GROUPED: 0 products'));
  });

  it('should warn when pair features are not found', () => {
    const pairs: Pair[] = [createPair({ frontUrl: 'https://example.com/missing.jpg', backUrl: 'https://example.com/missing2.jpg' })];
    groupExtrasWithProducts(pairs, new Map());
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not find features'));
  });

  it('should generate safe product IDs', () => {
    const pairs: Pair[] = [createPair({ brand: 'Test@Brand#123', product: 'Cool Product!!' })];
    const features = new Map<string, FeatureRow>([
      ['https://example.com/front.jpg', createFeature({ role: 'front' })],
      ['https://example.com/back.jpg', createFeature({ role: 'back' })],
    ]);
    const result = groupExtrasWithProducts(pairs, features);
    expect(result[0].productId).toMatch(/^[a-z0-9_]+$/);
  });

  it('should handle missing brand gracefully', () => {
    const pairs: Pair[] = [createPair({ brand: undefined as any })];
    const features = new Map<string, FeatureRow>([
      ['https://example.com/front.jpg', createFeature({ role: 'front' })],
      ['https://example.com/back.jpg', createFeature({ role: 'back' })],
    ]);
    const result = groupExtrasWithProducts(pairs, features);
    expect(result[0].evidence.brand).toBe('unknown');
  });

  it('should attach "other" role images', () => {
    const pairs: Pair[] = [createPair({})];
    const features = new Map<string, FeatureRow>([
      ['https://example.com/front.jpg', createFeature({ role: 'front', brandNorm: 'test' })],
      ['https://example.com/back.jpg', createFeature({ role: 'back', brandNorm: 'test' })],
      ['https://example.com/other.jpg', createFeature({ url: 'https://example.com/other.jpg', role: 'other', brandNorm: 'test' })],
    ]);
    const result = groupExtrasWithProducts(pairs, features);
    expect(result[0].extras).toContain('https://example.com/other.jpg');
  });
});
