/**
 * Unit tests for normalizeAspects - Aspect normalization and validation
 */

describe('normalizeAspects', () => {
  // Mock product for testing
  const mockProduct = {
    productId: 'test-123',
    brand: 'TestBrand',
    product: 'Test Product',
    size: '12 oz',
    frontUrl: 'http://example.com/front.jpg',
    backUrl: 'http://example.com/back.jpg',
    heroDisplayUrl: 'http://example.com/hero.jpg',
    backDisplayUrl: 'http://example.com/back.jpg',
  };

  // The normalization function under test
  const normalizeAspects = (aspects: any, product: any): Record<string, string[]> => {
    const normalized: Record<string, string[]> = {};
    
    if (aspects && typeof aspects === 'object') {
      for (const [key, value] of Object.entries(aspects)) {
        if (!key || key.trim() === '') continue;
        
        const cleanKey = key.trim();
        const valueArray = Array.isArray(value) ? value : [value];
        const cleanValues = valueArray
          .filter((v: any) => v !== null && v !== undefined && v !== '')
          .map((v: any) => String(v).trim())
          .filter((v: string) => v.length > 0);
        
        if (cleanValues.length > 0) {
          normalized[cleanKey] = cleanValues;
        }
      }
    }
    
    // Ensure Brand is present
    if (!normalized.Brand && product.brand) {
      normalized.Brand = [product.brand];
    }
    
    // Ensure Size is present if product has size
    if (!normalized.Size && product.size) {
      normalized.Size = [product.size];
    }
    
    return normalized;
  };

  describe('Array conversion', () => {
    test('should convert single string value to array', () => {
      const result = normalizeAspects({ Type: 'Supplement' }, mockProduct);
      
      expect(result.Type).toEqual(['Supplement']);
    });

    test('should keep array values as arrays', () => {
      const result = normalizeAspects({ Features: ['Gluten Free', 'Vegan'] }, mockProduct);
      
      expect(result.Features).toEqual(['Gluten Free', 'Vegan']);
    });

    test('should convert number to string array', () => {
      const result = normalizeAspects({ Count: 60 }, mockProduct);
      
      expect(result.Count).toEqual(['60']);
    });

    test('should convert boolean to string array', () => {
      const result = normalizeAspects({ Organic: true }, mockProduct);
      
      expect(result.Organic).toEqual(['true']);
    });

    test('should handle mixed type arrays', () => {
      const result = normalizeAspects({ Mixed: [123, 'text', true] }, mockProduct);
      
      expect(result.Mixed).toEqual(['123', 'text', 'true']);
    });
  });

  describe('Sanitization', () => {
    test('should trim whitespace from keys', () => {
      const result = normalizeAspects({ '  Brand  ': 'TestBrand' }, mockProduct);
      
      expect(result.Brand).toEqual(['TestBrand']);
      expect(result['  Brand  ']).toBeUndefined();
    });

    test('should trim whitespace from values', () => {
      const result = normalizeAspects({ Type: '  Supplement  ' }, mockProduct);
      
      expect(result.Type).toEqual(['Supplement']);
    });

    test('should remove empty string values', () => {
      const result = normalizeAspects({ Features: ['Good', '', 'Bad', '   '] }, mockProduct);
      
      expect(result.Features).toEqual(['Good', 'Bad']);
    });

    test('should remove null and undefined values', () => {
      const result = normalizeAspects({ Mixed: ['Valid', null, undefined, 'Also Valid'] }, mockProduct);
      
      expect(result.Mixed).toEqual(['Valid', 'Also Valid']);
    });

    test('should skip empty key names', () => {
      const result = normalizeAspects({ '': 'value', '  ': 'value2' }, mockProduct);
      
      expect(Object.keys(result).filter(k => k === '' || k === '  ')).toHaveLength(0);
    });

    test('should skip aspects with no valid values', () => {
      const result = normalizeAspects({ Empty: [], NullOnly: [null], UndefinedOnly: [undefined] }, mockProduct);
      
      expect(result.Empty).toBeUndefined();
      expect(result.NullOnly).toBeUndefined();
      expect(result.UndefinedOnly).toBeUndefined();
    });
  });

  describe('Brand enforcement', () => {
    test('should add Brand from product if missing', () => {
      const result = normalizeAspects({ Type: 'Supplement' }, mockProduct);
      
      expect(result.Brand).toEqual(['TestBrand']);
    });

    test('should keep existing Brand if present', () => {
      const result = normalizeAspects({ Brand: 'DifferentBrand' }, mockProduct);
      
      expect(result.Brand).toEqual(['DifferentBrand']);
    });

    test('should not add Brand if product.brand is missing', () => {
      const productNoBrand = { ...mockProduct, brand: undefined };
      const result = normalizeAspects({ Type: 'Supplement' }, productNoBrand);
      
      expect(result.Brand).toBeUndefined();
    });

    test('should handle Brand as array', () => {
      const result = normalizeAspects({ Brand: ['Brand1', 'Brand2'] }, mockProduct);
      
      expect(result.Brand).toEqual(['Brand1', 'Brand2']);
    });
  });

  describe('Size enforcement', () => {
    test('should add Size from product if missing', () => {
      const result = normalizeAspects({ Type: 'Supplement' }, mockProduct);
      
      expect(result.Size).toEqual(['12 oz']);
    });

    test('should keep existing Size if present', () => {
      const result = normalizeAspects({ Size: '16 oz' }, mockProduct);
      
      expect(result.Size).toEqual(['16 oz']);
    });

    test('should not add Size if product.size is missing', () => {
      const productNoSize = { ...mockProduct, size: undefined };
      const result = normalizeAspects({ Type: 'Supplement' }, productNoSize);
      
      expect(result.Size).toBeUndefined();
    });

    test('should handle Size as array', () => {
      const result = normalizeAspects({ Size: ['Small', 'Medium'] }, mockProduct);
      
      expect(result.Size).toEqual(['Small', 'Medium']);
    });
  });

  describe('Edge cases', () => {
    test('should handle null aspects input', () => {
      const result = normalizeAspects(null, mockProduct);
      
      expect(result.Brand).toEqual(['TestBrand']);
      expect(result.Size).toEqual(['12 oz']);
    });

    test('should handle undefined aspects input', () => {
      const result = normalizeAspects(undefined, mockProduct);
      
      expect(result.Brand).toEqual(['TestBrand']);
      expect(result.Size).toEqual(['12 oz']);
    });

    test('should handle empty object', () => {
      const result = normalizeAspects({}, mockProduct);
      
      expect(result.Brand).toEqual(['TestBrand']);
      expect(result.Size).toEqual(['12 oz']);
    });

    test('should handle non-object input', () => {
      const result = normalizeAspects('not an object' as any, mockProduct);
      
      expect(result.Brand).toEqual(['TestBrand']);
    });

    test('should handle array input', () => {
      const result = normalizeAspects(['array', 'values'] as any, mockProduct);
      
      // Arrays are objects, but entries() will iterate indices
      // This is an edge case - should still add Brand/Size
      expect(result.Brand).toEqual(['TestBrand']);
    });
  });

  describe('Real-world scenarios', () => {
    test('should normalize complete GPT response aspects', () => {
      const gptAspects = {
        Brand: 'Natural Stacks',
        'Main Purpose': 'Brain Health',
        Formulation: 'Capsule',
        Ingredients: 'L-Tyrosine, Vitamin B6',
        Features: ['Gluten Free', 'Vegan', 'Non-GMO'],
      };

      const result = normalizeAspects(gptAspects, {
        ...mockProduct,
        brand: 'Natural Stacks',
      });

      expect(result.Brand).toEqual(['Natural Stacks']);
      expect(result['Main Purpose']).toEqual(['Brain Health']);
      expect(result.Formulation).toEqual(['Capsule']);
      expect(result.Ingredients).toEqual(['L-Tyrosine, Vitamin B6']);
      expect(result.Features).toEqual(['Gluten Free', 'Vegan', 'Non-GMO']);
    });

    test('should handle GPT returning empty Brand', () => {
      const result = normalizeAspects({ Brand: '' }, mockProduct);
      
      // Empty Brand should be removed, then re-added from product
      expect(result.Brand).toEqual(['TestBrand']);
    });

    test('should preserve special characters in aspect names', () => {
      const result = normalizeAspects({
        'Active Ingredient(s)': 'Vitamin D3',
        'Country/Region of Manufacture': 'USA',
      }, mockProduct);

      expect(result['Active Ingredient(s)']).toEqual(['Vitamin D3']);
      expect(result['Country/Region of Manufacture']).toEqual(['USA']);
    });

    test('should handle multi-value aspects from eBay', () => {
      const result = normalizeAspects({
        Color: ['Red', 'Blue', 'Green'],
        'Compatible Brand': ['Apple', 'Samsung'],
      }, mockProduct);

      expect(result.Color).toEqual(['Red', 'Blue', 'Green']);
      expect(result['Compatible Brand']).toEqual(['Apple', 'Samsung']);
    });

    test('should handle typical book aspects', () => {
      const bookProduct = {
        productId: 'book-123',
        brand: 'Publisher XYZ',
        product: 'Book Title',
        size: 'Hardcover',
        frontUrl: 'http://example.com/front.jpg',
        backUrl: 'http://example.com/back.jpg',
        heroDisplayUrl: 'http://example.com/hero.jpg',
        backDisplayUrl: 'http://example.com/back.jpg',
      };

      const result = normalizeAspects({
        Author: 'John Doe',
        'Publication Year': 2020,
        Format: 'Hardcover',
        Language: 'English',
      }, bookProduct);

      expect(result.Brand).toEqual(['Publisher XYZ']);
      expect(result.Author).toEqual(['John Doe']);
      expect(result['Publication Year']).toEqual(['2020']);
      expect(result.Format).toEqual(['Hardcover']);
    });
  });

  describe('Duplicate handling', () => {
    test('should preserve duplicate values in arrays', () => {
      // Some eBay categories allow duplicate values (e.g., Multiple "Red" items)
      const result = normalizeAspects({
        Color: ['Red', 'Red', 'Blue'],
      }, mockProduct);

      expect(result.Color).toEqual(['Red', 'Red', 'Blue']);
    });

    test('should not deduplicate aspect names (case matters)', () => {
      const result = normalizeAspects({
        brand: 'lowercase',
        Brand: 'Capitalized',
      }, mockProduct);

      // JavaScript objects with different case are different keys
      expect(result.brand).toEqual(['lowercase']);
      expect(result.Brand).toEqual(['Capitalized']);
    });
  });
});
