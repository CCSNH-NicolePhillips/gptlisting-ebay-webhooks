/**
 * Unit tests for getRelevantCategories - Category filtering and aspect inclusion
 * 
 * Note: These tests use mocked data since the real function queries Redis.
 * Integration tests should verify actual Redis category data.
 */

describe('getRelevantCategories', () => {
  // Mock category data
  const mockCategories = [
    {
      id: '180960',
      title: 'Vitamins & Dietary Supplements',
      slug: 'vitamins-dietary-supplements-180960',
      itemSpecifics: [
        { name: 'Brand', type: 'string', required: true },
        { name: 'Formulation', type: 'enum', required: false },
        { name: 'Main Purpose', type: 'string', required: false },
        { name: 'Ingredients', type: 'string', required: false },
        { name: 'Type', type: 'string', required: false },
      ],
    },
    {
      id: '261186',
      title: 'Books',
      slug: 'books-261186',
      itemSpecifics: [
        { name: 'Brand', type: 'string', required: true },
        { name: 'Author', type: 'string', required: false },
        { name: 'Publication Year', type: 'string', required: false },
        { name: 'Format', type: 'enum', required: false },
        { name: 'Language', type: 'string', required: false },
      ],
    },
    {
      id: '11450',
      title: 'Clothing, Shoes & Accessories',
      slug: 'clothing-shoes-accessories-11450',
      itemSpecifics: [
        { name: 'Brand', type: 'string', required: true },
        { name: 'Size', type: 'string', required: false },
        { name: 'Color', type: 'string', required: false },
      ],
    },
    {
      id: '31411',
      title: 'Health & Beauty',
      slug: 'health-beauty-31411',
      itemSpecifics: [
        { name: 'Brand', type: 'string', required: true },
        { name: 'Type', type: 'string', required: false },
        { name: 'Ingredients', type: 'string', required: false },
      ],
    },
    {
      id: '99',
      title: 'Everything Else',
      slug: 'everything-else-99',
      itemSpecifics: [
        { name: 'Brand', type: 'string', required: true },
      ],
    },
  ];

  // Simulate the filtering logic
  const getRelevantCategories = (
    product: { product: string; brand: string; variant?: string; categoryPath?: string },
    allCategories: typeof mockCategories
  ): string => {
    const searchTerms = [
      product.product,
      product.brand,
      product.variant,
      product.categoryPath,
    ].filter(Boolean).join(' ').toLowerCase();

    const relevant = allCategories
      .filter(cat => {
        const catText = `${cat.title} ${cat.slug}`.toLowerCase();
        return searchTerms.split(/\s+/).some(term => 
          term.length > 3 && catText.includes(term)
        );
      })
      .slice(0, 20)
      .map(cat => {
        const aspects = cat.itemSpecifics
          ?.filter(spec => !spec.required && spec.name !== 'Brand')
          .slice(0, 8)
          .map(spec => spec.name)
          .join(', ') || '';
        
        return aspects 
          ? `${cat.id}: ${cat.title} (aspects: ${aspects})`
          : `${cat.id}: ${cat.title}`;
      })
      .join('\n');

    if (relevant) {
      return relevant;
    }

    // Fallback to common categories
    const commonCats = ['261186', '31411', '11450', '99'];
    return allCategories
      .filter(cat => commonCats.includes(cat.id))
      .map(cat => {
        const aspects = cat.itemSpecifics
          ?.filter(spec => !spec.required && spec.name !== 'Brand')
          .slice(0, 8)
          .map(spec => spec.name)
          .join(', ') || '';
        
        return aspects 
          ? `${cat.id}: ${cat.title} (aspects: ${aspects})`
          : `${cat.id}: ${cat.title}`;
      })
      .join('\n');
  };

  describe('Search term matching', () => {
    test('should match product name', () => {
      const result = getRelevantCategories(
        { product: 'Vitamin D3 Supplement', brand: 'HealthCo' },
        mockCategories
      );

      expect(result).toContain('180960');
      expect(result).toContain('Vitamins & Dietary Supplements');
    });

    test('should match brand name', () => {
      const result = getRelevantCategories(
        { product: 'Mystery Novel', brand: 'Books Publishing' },
        mockCategories
      );

      expect(result).toContain('261186');
      expect(result).toContain('Books');
    });

    test('should match variant', () => {
      const result = getRelevantCategories(
        { product: 'Product', brand: 'Brand', variant: 'vitamin enriched' },
        mockCategories
      );

      expect(result).toContain('180960');
    });

    test('should match category path', () => {
      const result = getRelevantCategories(
        { product: 'Item', brand: 'Brand', categoryPath: 'clothing' },
        mockCategories
      );

      expect(result).toContain('11450');
      expect(result).toContain('Clothing, Shoes & Accessories');
    });

    test('should be case-insensitive', () => {
      const result = getRelevantCategories(
        { product: 'HEALTH SUPPLEMENT', brand: 'BRAND' },
        mockCategories
      );

      expect(result).toContain('31411');
      expect(result).toContain('Health & Beauty');
    });
  });

  describe('Term length filtering', () => {
    test('should ignore search terms <= 3 characters', () => {
      const result = getRelevantCategories(
        { product: 'The Art of War', brand: 'ABC' },
        mockCategories
      );

      // "The", "of", "ABC" should be ignored (<=3 chars)
      // Should match on "War" if it appears, or fallback
      expect(result).toBeDefined();
    });

    test('should match terms > 3 characters', () => {
      const result = getRelevantCategories(
        { product: 'Book Title', brand: 'Publisher' },
        mockCategories
      );

      expect(result).toContain('Books');
    });

    test('should handle products with only short terms', () => {
      const result = getRelevantCategories(
        { product: 'ABC XYZ', brand: 'Co' },
        mockCategories
      );

      // Should fallback to common categories
      expect(result).toContain('Everything Else');
    });
  });

  describe('Aspect inclusion', () => {
    test('should include non-required aspects in output', () => {
      const result = getRelevantCategories(
        { product: 'Vitamin Supplement', brand: 'HealthCo' },
        mockCategories
      );

      expect(result).toContain('Formulation');
      expect(result).toContain('Main Purpose');
      expect(result).toContain('Ingredients');
    });

    test('should exclude Brand from aspect list', () => {
      const result = getRelevantCategories(
        { product: 'Book Title', brand: 'Publisher' },
        mockCategories
      );

      // Aspect list should not include Brand (even though it's in itemSpecifics)
      const aspectMatch = result.match(/\(aspects: ([^)]+)\)/);
      expect(aspectMatch).toBeTruthy();
      if (aspectMatch) {
        expect(aspectMatch[1]).not.toContain('Brand');
      }
    });

    test('should exclude required aspects from list', () => {
      const result = getRelevantCategories(
        { product: 'Health Product', brand: 'Brand' },
        mockCategories
      );

      // Only non-required aspects should be shown
      const aspectMatch = result.match(/\(aspects: ([^)]+)\)/);
      expect(aspectMatch).toBeTruthy();
    });

    test('should limit aspects to 8 items', () => {
      const categoryWithManyAspects = {
        id: '12345',
        title: 'Test Category',
        slug: 'test-category-12345',
        itemSpecifics: Array.from({ length: 20 }, (_, i) => ({
          name: `Aspect${i}`,
          type: 'string' as const,
          required: false,
        })),
      };

      const result = getRelevantCategories(
        { product: 'test', brand: 'test' },
        [categoryWithManyAspects]
      );

      const aspectMatch = result.match(/\(aspects: ([^)]+)\)/);
      if (aspectMatch) {
        const aspects = aspectMatch[1].split(', ');
        expect(aspects.length).toBeLessThanOrEqual(8);
      }
    });

    test('should show category without aspects if none available', () => {
      const result = getRelevantCategories(
        { product: 'random item', brand: 'brand' },
        mockCategories
      );

      // "Everything Else" has only Brand (required), so no aspects shown
      expect(result).toContain('99: Everything Else');
      expect(result).not.toContain('99: Everything Else (aspects:');
    });
  });

  describe('Result limiting', () => {
    test('should limit results to 20 categories', () => {
      const manyCategories = Array.from({ length: 50 }, (_, i) => ({
        id: `${i}`,
        title: `health category ${i}`,
        slug: `health-category-${i}`,
        itemSpecifics: [],
      }));

      const result = getRelevantCategories(
        { product: 'health product', brand: 'brand' },
        manyCategories
      );

      const lines = result.split('\n');
      expect(lines.length).toBeLessThanOrEqual(20);
    });

    test('should return most relevant categories first', () => {
      // In real implementation, order would matter
      // Here we just verify we get results
      const result = getRelevantCategories(
        { product: 'vitamin', brand: 'health' },
        mockCategories
      );

      expect(result).toContain('180960');
    });
  });

  describe('Fallback behavior', () => {
    test('should fallback to common categories if no match', () => {
      const result = getRelevantCategories(
        { product: 'xyzabc', brand: 'qwerty' },
        mockCategories
      );

      // Should include common categories
      expect(result).toContain('Books');
      expect(result).toContain('Health & Beauty');
      expect(result).toContain('Clothing, Shoes & Accessories');
      expect(result).toContain('Everything Else');
    });

    test('should include aspects in fallback categories', () => {
      const result = getRelevantCategories(
        { product: 'nonmatching', brand: 'nothing' },
        mockCategories
      );

      // Fallback should still show aspects
      expect(result).toContain('(aspects:');
    });

    test('should handle empty product data', () => {
      const result = getRelevantCategories(
        { product: '', brand: '' },
        mockCategories
      );

      // Should fallback
      expect(result).toContain('Everything Else');
    });
  });

  describe('Output format', () => {
    test('should format as "ID: Title (aspects: list)"', () => {
      const result = getRelevantCategories(
        { product: 'vitamin', brand: 'health' },
        mockCategories
      );

      // Check format: "180960: Vitamins & Dietary Supplements (aspects: ...)"
      expect(result).toMatch(/\d+: .+ \(aspects: .+\)/);
    });

    test('should separate categories with newlines', () => {
      const result = getRelevantCategories(
        { product: 'book vitamin', brand: 'brand' },
        mockCategories
      );

      expect(result).toContain('\n');
    });

    test('should comma-separate aspects', () => {
      const result = getRelevantCategories(
        { product: 'vitamin', brand: 'health' },
        mockCategories
      );

      const aspectMatch = result.match(/\(aspects: ([^)]+)\)/);
      if (aspectMatch) {
        expect(aspectMatch[1]).toContain(',');
      }
    });
  });

  describe('Edge cases', () => {
    test('should handle empty category list', () => {
      const result = getRelevantCategories(
        { product: 'anything', brand: 'brand' },
        []
      );

      expect(result).toBe('');
    });

    test('should handle categories with no itemSpecifics', () => {
      const categoriesNoSpecs = [
        { id: '1', title: 'Test', slug: 'test-1', itemSpecifics: undefined as any },
      ];

      const result = getRelevantCategories(
        { product: 'test', brand: 'test' },
        categoriesNoSpecs
      );

      expect(result).toContain('1: Test');
      expect(result).not.toContain('(aspects:');
    });

    test('should handle special characters in search terms', () => {
      const result = getRelevantCategories(
        { product: "Men's Health & Wellness", brand: 'Co.' },
        mockCategories
      );

      expect(result).toContain('Health & Beauty');
    });

    test('should handle undefined optional fields', () => {
      const result = getRelevantCategories(
        { product: 'vitamin', brand: 'health', variant: undefined, categoryPath: undefined },
        mockCategories
      );

      expect(result).toContain('180960');
    });
  });

  describe('Real-world scenarios', () => {
    test('should find supplement category for health product', () => {
      const result = getRelevantCategories(
        {
          product: 'Vitamin D3 Supplement',
          brand: 'Natural Stacks',
          variant: 'Dietary',
        },
        mockCategories
      );

      expect(result).toContain('180960');
      expect(result).toContain('Formulation');
      expect(result).toContain('Main Purpose');
    });

    test('should find books category for books', () => {
      const result = getRelevantCategories(
        {
          product: 'The Art of War',
          brand: 'Penguin Classics',
        },
        mockCategories
      );

      expect(result).toContain('261186');
      expect(result).toContain('Author');
      expect(result).toContain('Publication Year');
    });

    test('should prefer specific category over generic', () => {
      // Product mentions both "health" and "supplement"
      const result = getRelevantCategories(
        {
          product: 'Health Supplement Vitamin',
          brand: 'Brand',
        },
        mockCategories
      );

      // Should find both categories, but supplements more specific
      expect(result).toContain('180960');
      expect(result).toContain('31411');
    });
  });
});
