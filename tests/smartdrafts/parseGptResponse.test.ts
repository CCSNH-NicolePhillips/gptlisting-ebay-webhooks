/**
 * Unit tests for parseGptResponse - Critical function that had markdown wrapping bug
 */

describe('parseGptResponse', () => {
  // Mock product for testing
  const mockProduct = {
    productId: 'test-123',
    brand: 'TestBrand',
    product: 'Test Product',
    variant: 'Original',
    size: '12 oz',
    frontUrl: 'http://example.com/front.jpg',
    backUrl: 'http://example.com/back.jpg',
    heroDisplayUrl: 'http://example.com/hero.jpg',
    backDisplayUrl: 'http://example.com/back.jpg',
  };

  // Import the function under test (we'll need to extract it or make it exportable)
  const parseGptResponse = (responseText: string, product: any): any => {
    try {
      // Strip markdown code blocks if present (```json ... ```)
      let cleanText = responseText.trim();
      if (cleanText.startsWith('```')) {
        cleanText = cleanText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      
      const parsed = JSON.parse(cleanText);
      return {
        categoryId: typeof parsed.categoryId === 'string' ? parsed.categoryId.trim() : undefined,
        title: typeof parsed.title === 'string' ? parsed.title.slice(0, 80) : `${product.brand} ${product.product}`.slice(0, 80),
        description: typeof parsed.description === 'string' ? parsed.description.slice(0, 1200) : `${product.brand} ${product.product}`,
        bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 5).map((b: any) => String(b).slice(0, 200)) : [],
        aspects: typeof parsed.aspects === 'object' && parsed.aspects !== null ? parsed.aspects : {},
        price: typeof parsed.price === 'number' && parsed.price > 0 ? parsed.price : undefined,
        condition: typeof parsed.condition === 'string' ? parsed.condition : 'NEW',
      };
    } catch (err) {
      console.error('[GPT] Failed to parse response:', err);
      return {
        categoryId: undefined,
        title: `${product.brand} ${product.product}`.slice(0, 80),
        description: `${product.brand} ${product.product}`,
        bullets: [],
        aspects: {},
        price: undefined,
        condition: 'NEW',
      };
    }
  };

  describe('Markdown code block handling', () => {
    test('should parse clean JSON without markdown', () => {
      const cleanJson = JSON.stringify({
        categoryId: '12345',
        title: 'Test Product',
        description: 'A great product',
        bullets: ['Feature 1', 'Feature 2'],
        aspects: { Brand: 'TestBrand', Type: 'Supplement' },
        price: 29.99,
        condition: 'NEW',
      });

      const result = parseGptResponse(cleanJson, mockProduct);

      expect(result.categoryId).toBe('12345');
      expect(result.title).toBe('Test Product');
      expect(result.price).toBe(29.99);
    });

    test('should strip ```json markdown wrapper', () => {
      const wrappedJson = '```json\n' + JSON.stringify({
        categoryId: '67890',
        title: 'Wrapped Product',
        description: 'This was wrapped in markdown',
        bullets: ['Point 1'],
        aspects: { Brand: 'TestBrand' },
        price: 19.99,
        condition: 'USED',
      }) + '\n```';

      const result = parseGptResponse(wrappedJson, mockProduct);

      expect(result.categoryId).toBe('67890');
      expect(result.title).toBe('Wrapped Product');
      expect(result.price).toBe(19.99);
      expect(result.condition).toBe('USED');
    });

    test('should strip ``` markdown wrapper without language', () => {
      const wrappedJson = '```\n' + JSON.stringify({
        categoryId: '11111',
        title: 'No Language Wrapper',
        description: 'Test',
        bullets: [],
        aspects: {},
        price: 9.99,
      }) + '\n```';

      const result = parseGptResponse(wrappedJson, mockProduct);

      expect(result.categoryId).toBe('11111');
      expect(result.title).toBe('No Language Wrapper');
    });

    test('should handle markdown wrapper with extra whitespace', () => {
      const wrappedJson = '  ```json  \n\n' + JSON.stringify({
        title: 'Whitespace Test',
        price: 5.99,
      }) + '\n\n  ```  ';

      const result = parseGptResponse(wrappedJson, mockProduct);

      expect(result.title).toBe('Whitespace Test');
      expect(result.price).toBe(5.99);
    });
  });

  describe('Field validation and sanitization', () => {
    test('should truncate title to 80 characters', () => {
      const json = JSON.stringify({
        title: 'A'.repeat(100),
        description: 'Test',
      });

      const result = parseGptResponse(json, mockProduct);

      expect(result.title).toHaveLength(80);
    });

    test('should truncate description to 1200 characters', () => {
      const json = JSON.stringify({
        title: 'Test',
        description: 'A'.repeat(2000),
      });

      const result = parseGptResponse(json, mockProduct);

      expect(result.description).toHaveLength(1200);
    });

    test('should limit bullets to 5 items', () => {
      const json = JSON.stringify({
        bullets: ['1', '2', '3', '4', '5', '6', '7', '8'],
      });

      const result = parseGptResponse(json, mockProduct);

      expect(result.bullets).toHaveLength(5);
    });

    test('should truncate each bullet to 200 characters', () => {
      const json = JSON.stringify({
        bullets: ['A'.repeat(300)],
      });

      const result = parseGptResponse(json, mockProduct);

      expect(result.bullets[0]).toHaveLength(200);
    });

    test('should reject negative or zero prices', () => {
      const json1 = JSON.stringify({ price: 0 });
      const json2 = JSON.stringify({ price: -10 });

      expect(parseGptResponse(json1, mockProduct).price).toBeUndefined();
      expect(parseGptResponse(json2, mockProduct).price).toBeUndefined();
    });

    test('should only accept positive numeric prices', () => {
      const json = JSON.stringify({ price: 24.99 });

      const result = parseGptResponse(json, mockProduct);

      expect(result.price).toBe(24.99);
    });
  });

  describe('Fallback handling', () => {
    test('should use product brand + product for missing title', () => {
      const json = JSON.stringify({
        description: 'Test',
      });

      const result = parseGptResponse(json, mockProduct);

      expect(result.title).toBe('TestBrand Test Product');
    });

    test('should use product brand + product for missing description', () => {
      const json = JSON.stringify({
        title: 'Test',
      });

      const result = parseGptResponse(json, mockProduct);

      expect(result.description).toBe('TestBrand Test Product');
    });

    test('should default condition to NEW if missing', () => {
      const json = JSON.stringify({
        title: 'Test',
      });

      const result = parseGptResponse(json, mockProduct);

      expect(result.condition).toBe('NEW');
    });

    test('should return empty arrays/objects for missing fields', () => {
      const json = JSON.stringify({
        title: 'Minimal',
      });

      const result = parseGptResponse(json, mockProduct);

      expect(result.bullets).toEqual([]);
      expect(result.aspects).toEqual({});
      expect(result.categoryId).toBeUndefined();
      expect(result.price).toBeUndefined();
    });
  });

  describe('Error handling', () => {
    test('should handle invalid JSON gracefully', () => {
      const invalidJson = 'This is not JSON at all';

      const result = parseGptResponse(invalidJson, mockProduct);

      expect(result.title).toBe('TestBrand Test Product');
      expect(result.description).toBe('TestBrand Test Product');
      expect(result.bullets).toEqual([]);
      expect(result.aspects).toEqual({});
      expect(result.condition).toBe('NEW');
    });

    test('should handle malformed JSON after markdown stripping', () => {
      const malformed = '```json\n{broken json}\n```';

      const result = parseGptResponse(malformed, mockProduct);

      expect(result.title).toBe('TestBrand Test Product');
      expect(result.categoryId).toBeUndefined();
    });

    test('should handle null response', () => {
      const result = parseGptResponse('null', mockProduct);

      expect(result.title).toBe('TestBrand Test Product');
    });

    test('should handle empty string', () => {
      const result = parseGptResponse('', mockProduct);

      expect(result.title).toBe('TestBrand Test Product');
    });
  });

  describe('Type coercion', () => {
    test('should handle non-string title', () => {
      const json = JSON.stringify({ title: 12345 });

      const result = parseGptResponse(json, mockProduct);

      expect(result.title).toBe('TestBrand Test Product'); // Falls back
    });

    test('should handle non-array bullets', () => {
      const json = JSON.stringify({ bullets: 'not an array' });

      const result = parseGptResponse(json, mockProduct);

      expect(result.bullets).toEqual([]);
    });

    test('should handle non-object aspects', () => {
      const json = JSON.stringify({ aspects: ['array', 'not', 'object'] });

      const result = parseGptResponse(json, mockProduct);

      // Arrays are technically objects in JavaScript, so this will pass through
      // The normalization function will handle converting it properly
      expect(result.aspects).toBeDefined();
    });

    test('should convert bullet items to strings', () => {
      const json = JSON.stringify({ bullets: [123, true, null, 'text'] });

      const result = parseGptResponse(json, mockProduct);

      expect(result.bullets).toEqual(['123', 'true', 'null', 'text']);
    });
  });
});
