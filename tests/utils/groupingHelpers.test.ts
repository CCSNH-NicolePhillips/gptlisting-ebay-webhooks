/**
 * Comprehensive tests for utils/groupingHelpers.ts
 * Target: 100% code coverage
 */

import { normBrand, tokenize, jaccard, categoryCompat } from '../../src/utils/groupingHelpers';

describe('groupingHelpers.ts', () => {
  describe('normBrand', () => {
    it('should normalize brand names to lowercase', () => {
      expect(normBrand('BrandName')).toBe('brandname');
      expect(normBrand('UPPERCASE')).toBe('uppercase');
    });

    it('should remove dots', () => {
      // Removes dots, then takes first significant token
      expect(normBrand('Dr. Johns')).toBe('dr');
      expect(normBrand('U.S.A.')).toBe('usa');
    });

    it('should remove corporate suffixes', () => {
      expect(normBrand('Acme Inc')).toBe('acme');
      expect(normBrand('TechCo LLC')).toBe('techco');
      expect(normBrand('Brand Corp')).toBe('brand');
      // 'company' and 'ltd' are both suffix words, so result is empty
      expect(normBrand('Company Ltd')).toBe('');
      expect(normBrand('Test Brands')).toBe('test');
      expect(normBrand('Health Supplements')).toBe('health');
      // Both 'wellness' and 'nutrition' are suffix words, result is empty
      expect(normBrand('Wellness Nutrition')).toBe('');
      expect(normBrand('Jocko Fuel')).toBe('jocko');
    });

    it('should extract core brand from multi-word names', () => {
      expect(normBrand('Jocko Fuel')).toBe('jocko');
      expect(normBrand('Nature Made Wellness')).toBe('nature');
      expect(normBrand('Garden Life Vitamins')).toBe('garden');
    });

    it('should handle empty/null/undefined', () => {
      expect(normBrand(null)).toBe('');
      expect(normBrand(undefined)).toBe('');
      expect(normBrand('')).toBe('');
      expect(normBrand('Unknown')).toBe('');
    });

    it('should filter generic prefix words', () => {
      expect(normBrand('By Brand Name')).toBe('brand');
      // 'company' is a suffix word so it gets removed, leaving 'from the'
      // significantTokens filters 'the' but 'from' remains, so returns first: 'from'
      // But 'from' is also not in genericWords, so no tokens filtered, returns whole string
      expect(normBrand('From The Company')).toBe('from the');
      expect(normBrand('A Good Brand')).toBe('good');
      expect(normBrand('An Excellent Brand')).toBe('excellent');
    });

    it('should handle special characters', () => {
      expect(normBrand('Brand-Name')).toBe('brand');
      expect(normBrand('Brand & Co')).toBe('brand');
      expect(normBrand('Brand/Company')).toBe('brand');
    });

    it('should handle single-word brands', () => {
      expect(normBrand('Nike')).toBe('nike');
      expect(normBrand('Apple')).toBe('apple');
    });

    it('should handle whitespace', () => {
      expect(normBrand('  Brand  Name  ')).toBe('brand');
      expect(normBrand('Brand   With   Spaces')).toBe('brand');
    });
  });

  describe('tokenize', () => {
    it('should tokenize string into normalized words', () => {
      expect(tokenize('Hello World')).toEqual(['hello', 'world']);
      expect(tokenize('Test Product Name')).toEqual(['test', 'product', 'name']);
    });

    it('should handle lowercase', () => {
      expect(tokenize('UPPERCASE TEXT')).toEqual(['uppercase', 'text']);
      expect(tokenize('MixedCase')).toEqual(['mixedcase']);
    });

    it('should remove special characters', () => {
      expect(tokenize('hello-world')).toEqual(['hello', 'world']);
      expect(tokenize('test_product')).toEqual(['test', 'product']);
      expect(tokenize('brand@name#test')).toEqual(['brand', 'name', 'test']);
    });

    it('should handle numbers', () => {
      expect(tokenize('Product123')).toEqual(['product123']);
      expect(tokenize('Test 500mg')).toEqual(['test', '500mg']);
    });

    it('should filter empty tokens', () => {
      expect(tokenize('  hello   world  ')).toEqual(['hello', 'world']);
      expect(tokenize('test---product')).toEqual(['test', 'product']);
    });

    it('should handle empty/null/undefined', () => {
      expect(tokenize(null)).toEqual([]);
      expect(tokenize(undefined)).toEqual([]);
      expect(tokenize('')).toEqual([]);
      expect(tokenize('   ')).toEqual([]);
    });

    it('should handle punctuation', () => {
      expect(tokenize('hello, world!')).toEqual(['hello', 'world']);
      expect(tokenize('test (product) [name]')).toEqual(['test', 'product', 'name']);
    });
  });

  describe('jaccard', () => {
    it('should calculate Jaccard similarity for identical sets', () => {
      expect(jaccard(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
    });

    it('should calculate Jaccard similarity for disjoint sets', () => {
      expect(jaccard(['a', 'b'], ['c', 'd'])).toBe(0);
    });

    it('should calculate Jaccard similarity for partial overlap', () => {
      const result = jaccard(['a', 'b', 'c'], ['b', 'c', 'd']);
      expect(result).toBeCloseTo(0.5, 5); // 2 common / 4 total
    });

    it('should handle empty arrays', () => {
      expect(jaccard([], [])).toBe(0);
      expect(jaccard(['a'], [])).toBe(0);
      expect(jaccard([], ['a'])).toBe(0);
    });

    it('should handle single element', () => {
      expect(jaccard(['a'], ['a'])).toBe(1);
      expect(jaccard(['a'], ['b'])).toBe(0);
    });

    it('should handle duplicates in arrays', () => {
      // Sets deduplicate automatically
      expect(jaccard(['a', 'a', 'b'], ['a', 'b', 'b'])).toBe(1);
    });

    it('should calculate correctly with different sizes', () => {
      const result = jaccard(['a', 'b'], ['a', 'b', 'c', 'd']);
      expect(result).toBeCloseTo(0.5, 5); // 2 common / 4 total
    });

    it('should handle case sensitivity', () => {
      expect(jaccard(['a', 'b'], ['A', 'B'])).toBe(0); // Case matters
    });
  });

  describe('categoryCompat', () => {
    it('should return 1.0 for same meaningful category', () => {
      expect(categoryCompat('Supplements > Vitamins', 'Supplements > Minerals')).toBe(1.0);
      expect(categoryCompat('Food > Snacks', 'Food > Beverages')).toBe(1.0);
      expect(categoryCompat('Hair > Shampoo', 'Hair > Conditioner')).toBe(1.0);
      expect(categoryCompat('Skin Care > Moisturizer', 'Cosmetic > Makeup')).toBe(1.0);
    });

    it('should return 0.2 when one is "other"', () => {
      expect(categoryCompat('Books', 'Supplements')).toBe(0.2);
      expect(categoryCompat('Supplements', 'Electronics')).toBe(0.2);
    });

    it('should return -1.0 for incompatible categories', () => {
      expect(categoryCompat('Hair > Products', 'Supplements > Vitamins')).toBe(-1.0);
      expect(categoryCompat('Supplements > Vitamins', 'Hair > Products')).toBe(-1.0);
      expect(categoryCompat('Hair > Care', 'Food > Snacks')).toBe(-1.0);
      expect(categoryCompat('Food > Items', 'Hair > Shampoo')).toBe(-1.0);
    });

    it('should return 0.4 for food and supplements compatibility', () => {
      // 'Supplements' → 'supp', 'Food > Beverage' → 'food'
      // supp and food are compatible with 0.4
      expect(categoryCompat('Supplements > Vitamins', 'Food > Beverage')).toBe(0.4);
      // 'Food > Protein' → 'food', 'Supplements > Protein' → 'supp'
      expect(categoryCompat('Food > Protein', 'Supplements > Protein')).toBe(0.4);
    });

    it('should return 0.0 for other incompatible pairs', () => {
      expect(categoryCompat('Accessories', 'Cosmetics')).toBe(0.0);
    });

    it('should handle empty/null/undefined', () => {
      expect(categoryCompat(null, null)).toBe(0.2);
      expect(categoryCompat(undefined, undefined)).toBe(0.2);
      expect(categoryCompat('', '')).toBe(0.2);
      expect(categoryCompat('Supplements', null)).toBe(0.2);
      expect(categoryCompat(null, 'Food')).toBe(0.2);
    });

    it('should handle case insensitivity', () => {
      expect(categoryCompat('SUPPLEMENTS > VITAMINS', 'supplements > minerals')).toBe(1.0);
      expect(categoryCompat('Hair > Products', 'SUPPLEMENTS > vitamins')).toBe(-1.0);
    });

    it('should not treat "other" as same category', () => {
      expect(categoryCompat('Books', 'Electronics')).toBe(0.2);
    });

    it('should identify accessory category', () => {
      expect(categoryCompat('Accessories > Phone', 'Accessories > Watch')).toBe(1.0);
    });

    it('should handle cosmetic vs skin care', () => {
      expect(categoryCompat('Skin Care', 'Cosmetic')).toBe(1.0);
      expect(categoryCompat('Makeup', 'SPF Cream')).toBe(1.0);
    });
  });
});
