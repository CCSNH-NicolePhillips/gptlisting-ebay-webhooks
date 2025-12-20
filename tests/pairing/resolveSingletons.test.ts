import { resolveSingletons } from '../../src/pairing/resolveSingletons.js';
import type { ProductGroup } from '../../src/pairing/schema.js';

describe('resolveSingletons', () => {
  const baseProduct = (brand: string, frontUrl: string): ProductGroup => ({
    productId: `p-${brand}`,
    frontUrl,
    backUrl: `${frontUrl}/back`,
    extras: [],
    evidence: {
      brand,
      product: `${brand}-product`,
      variant: null,
      matchScore: 1,
      confidence: 1,
      triggers: [],
    },
  });

  it('promotes a unique-brand front to a solo product', () => {
    const singletons = [
      {
        url: 'https://img/unique-front.jpg',
        role: 'front',
        brandNorm: 'UniqueBrand',
        productTokens: ['unique'],
        variantTokens: ['v1'],
      },
    ];
    const products: ProductGroup[] = [baseProduct('OtherBrand', 'https://img/other.jpg')];

    const result = resolveSingletons(singletons as any, products);

    expect(result.products).toHaveLength(2);
    const solo = result.products.find(p => p.productId.startsWith('solo:'));
    expect(solo).toBeDefined();
    expect(solo?.frontUrl).toBe('https://img/unique-front.jpg');
    expect(solo?.backUrl).toBe('');
    expect(solo?.evidence).toMatchObject({ brand: 'UniqueBrand', triggers: ['solo-product-unique-brand'], confidence: 0.5, matchScore: 0 });
    expect(result.remainingSingletons).toHaveLength(0);
  });

  it('attaches a matching-brand singleton as extra when score meets threshold', () => {
    const singletons = [
      {
        url: '20251220_alpha_front.jpg',
        role: 'back',
        brandNorm: 'Alpha',
      },
    ];
    const products: ProductGroup[] = [baseProduct('Alpha', '20251220_alpha_product.jpg')];

    const result = resolveSingletons(singletons as any, products);

    expect(result.products[0].extras).toEqual(['20251220_alpha_front.jpg']);
    expect(result.remainingSingletons).toHaveLength(0);
  });

  it('keeps singleton when no promotion or attachment rules apply', () => {
    const singletons = [
      { url: 'https://img/unknown.jpg', role: 'front', brandNorm: '' },
    ];
    const products: ProductGroup[] = [baseProduct('Known', 'https://img/known.jpg')];

    const result = resolveSingletons(singletons as any, products);

    expect(result.products).toHaveLength(1);
    expect(result.remainingSingletons).toEqual(singletons);
  });
});
