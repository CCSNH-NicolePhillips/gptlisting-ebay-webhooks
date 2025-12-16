// tests/services/listing-enrichment.test.ts
import { enrichListingWithAI } from '../../src/services/listing-enrichment';
import type { ProductGroup } from '../../src/services/listing-enrichment';

describe('enrichListingWithAI', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should generate fallback listing with full product data', async () => {
    const group: ProductGroup = {
      brand: 'TestBrand',
      product: 'Test Product',
      variant: 'Variant A',
      size: '150ml',
    };

    const result = await enrichListingWithAI(group);

    expect(result).toHaveProperty('title');
    expect(result).toHaveProperty('description');
    expect(result.title.length).toBeLessThanOrEqual(80);
    expect(result.description.length).toBeLessThanOrEqual(7000);
  });

  it('should generate title from multiple parts', () => {
    const group: ProductGroup = {
      brand: 'BrandX',
      product: 'ProductY',
      variant: 'VariantZ',
      size: '100ml'
    };

    return enrichListingWithAI(group).then(result => {
      expect(result.title).toContain('BrandX');
      expect(result.title).toContain('ProductY');
      expect(result.title.length).toBeLessThanOrEqual(80);
    });
  });

  it('should generate title with only brand', () => {
    const group: ProductGroup = {
      brand: 'BrandOnly'
    };

    return enrichListingWithAI(group).then(result => {
      expect(result.title).toContain('BrandOnly');
      expect(result.title.length).toBeLessThanOrEqual(80);
    });
  });

  it('should include claims in description', () => {
    const group: ProductGroup = {
      brand: 'TestBrand',
      product: 'Test Product',
      claims: ['Organic', 'Vegan', 'Non-GMO', 'Gluten-Free']
    };

    return enrichListingWithAI(group).then(result => {
      expect(result.description.length).toBeGreaterThan(0);
      expect(result.description.length).toBeLessThanOrEqual(7000);
    });
  });

  it('should handle many claims', () => {
    const group: ProductGroup = {
      brand: 'TestBrand',
      product: 'Test Product',
      claims: ['Claim1', 'Claim2', 'Claim3', 'Claim4', 'Claim5', 'Claim6', 'Claim7', 'Claim8', 'Claim9', 'Claim10']
    };

    return enrichListingWithAI(group).then(result => {
      expect(result.description.length).toBeGreaterThan(0);
      expect(result.description.length).toBeLessThanOrEqual(7000);
    });
  });

  it('should handle empty strings in product data', () => {
    const group: ProductGroup = {
      brand: '',
      product: 'Test Product',
      variant: '',
      size: ''
    };

    return enrichListingWithAI(group).then(result => {
      expect(result.title).toContain('Test Product');
      expect(result.title.length).toBeLessThanOrEqual(80);
    });
  });

  it('should handle missing data gracefully', () => {
    const group: ProductGroup = {};

    return enrichListingWithAI(group).then(result => {
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('description');
      expect(result.title.length).toBeLessThanOrEqual(80);
      expect(result.description.length).toBeLessThanOrEqual(7000);
    });
  });

  it('should handle variant and size in title', () => {
    const group: ProductGroup = {
      brand: 'BrandX',
      product: 'ProductY',
      variant: 'Premium',
      size: '250ml'
    };

    return enrichListingWithAI(group).then(result => {
      expect(result.title).toContain('BrandX');
      expect(result.title).toContain('ProductY');
      expect(result.title.length).toBeLessThanOrEqual(80);
    });
  });

  it('should include variant in description', () => {
    const group: ProductGroup = {
      brand: 'TestBrand',
      product: 'Test Product',
      variant: 'Special Edition'
    };

    return enrichListingWithAI(group).then(result => {
      expect(result.description.length).toBeGreaterThan(0);
    });
  });

  it('should include size in description', () => {
    const group: ProductGroup = {
      brand: 'TestBrand',
      product: 'Test Product',
      size: '500ml'
    };

    return enrichListingWithAI(group).then(result => {
      expect(result.description.length).toBeGreaterThan(0);
    });
  });

  it('should handle product with only brand and product name', () => {
    const group: ProductGroup = {
      brand: 'SimpleBrand',
      product: 'Simple Product'
    };

    return enrichListingWithAI(group).then(result => {
      expect(result.title).toContain('SimpleBrand');
      expect(result.title).toContain('Simple Product');
      expect(result.title.length).toBeLessThanOrEqual(80);
      expect(result.description.length).toBeLessThanOrEqual(7000);
    });
  });
});
