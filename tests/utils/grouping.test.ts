/**
 * Comprehensive tests for utils/grouping.ts
 * Target: 100% code coverage
 */

import { groupProductsFromDropbox } from '../../src/utils/grouping';

describe('grouping.ts', () => {
  describe('groupProductsFromDropbox', () => {
    it('should group files by SKU prefix', () => {
      const entries = [
        { name: 'SKU001_01.jpg', path_lower: '/sku001_01.jpg' },
        { name: 'SKU001_02.jpg', path_lower: '/sku001_02.jpg' },
        { name: 'SKU002_01.jpg', path_lower: '/sku002_01.jpg' },
      ];

      const result = groupProductsFromDropbox(entries);
      
      expect(result).toHaveLength(2);
      expect(result[0].sku).toBe('SKU001');
      expect(result[1].sku).toBe('SKU002');
    });

    it('should set main image for files starting with _01', () => {
      const entries = [
        { name: 'SKU001_01.jpg', path_lower: '/sku001_01.jpg' },
        { name: 'SKU001_02.jpg', path_lower: '/sku001_02.jpg' },
      ];

      const result = groupProductsFromDropbox(entries);
      
      expect(result[0].main).toEqual(entries[0]);
    });

    it('should set priceImageName for files starting with _price', () => {
      const entries = [
        { name: 'SKU001_01.jpg', path_lower: '/sku001_01.jpg' },
        { name: 'SKU001_price.jpg', path_lower: '/sku001_price.jpg' },
      ];

      const result = groupProductsFromDropbox(entries);
      
      expect(result[0].priceImageName).toBe('SKU001_price.jpg');
    });

    it('should add other files to gallery', () => {
      const entries = [
        { name: 'SKU001_01.jpg', path_lower: '/sku001_01.jpg' },
        { name: 'SKU001_02.jpg', path_lower: '/sku001_02.jpg' },
        { name: 'SKU001_03.jpg', path_lower: '/sku001_03.jpg' },
      ];

      const result = groupProductsFromDropbox(entries);
      
      expect(result[0].gallery).toHaveLength(2);
      expect(result[0].gallery).toContain(entries[1]);
      expect(result[0].gallery).toContain(entries[2]);
    });

    it('should ignore files without underscore', () => {
      const entries = [
        { name: 'image.jpg', path_lower: '/image.jpg' },
        { name: 'photo.png', path_lower: '/photo.png' },
        { name: 'SKU001_01.jpg', path_lower: '/sku001_01.jpg' },
      ];

      const result = groupProductsFromDropbox(entries);
      
      expect(result).toHaveLength(1);
      expect(result[0].sku).toBe('SKU001');
    });

    it('should ignore files with empty prefix or suffix', () => {
      const entries = [
        { name: '_file.jpg', path_lower: '/_file.jpg' },
        { name: 'file_.jpg', path_lower: '/file_.jpg' },
        { name: 'SKU001_01.jpg', path_lower: '/sku001_01.jpg' },
      ];

      const result = groupProductsFromDropbox(entries);
      
      expect(result).toHaveLength(1);
      expect(result[0].sku).toBe('SKU001');
    });

    it('should only return groups with main image', () => {
      const entries = [
        { name: 'SKU001_01.jpg', path_lower: '/sku001_01.jpg' },
        { name: 'SKU002_02.jpg', path_lower: '/sku002_02.jpg' },
        { name: 'SKU003_price.jpg', path_lower: '/sku003_price.jpg' },
      ];

      const result = groupProductsFromDropbox(entries);
      
      // Only SKU001 has _01 (main image)
      expect(result).toHaveLength(1);
      expect(result[0].sku).toBe('SKU001');
    });

    it('should handle case insensitive _01 and _price matching', () => {
      const entries = [
        { name: 'SKU001_01.JPG', path_lower: '/sku001_01.jpg' },
        { name: 'SKU001_PRICE.jpg', path_lower: '/sku001_price.jpg' },
        { name: 'SKU002_01capital.jpg', path_lower: '/sku002_01capital.jpg' },
      ];

      const result = groupProductsFromDropbox(entries);
      
      expect(result).toHaveLength(2);
      expect(result[0].main).toEqual(entries[0]);
      expect(result[0].priceImageName).toBe('SKU001_PRICE.jpg');
      expect(result[1].main).toEqual(entries[2]);
    });

    it('should handle multiple files in gallery', () => {
      const entries = [
        { name: 'SKU001_01.jpg', path_lower: '/sku001_01.jpg' },
        { name: 'SKU001_02.jpg', path_lower: '/sku001_02.jpg' },
        { name: 'SKU001_03.jpg', path_lower: '/sku001_03.jpg' },
        { name: 'SKU001_04.jpg', path_lower: '/sku001_04.jpg' },
        { name: 'SKU001_05.jpg', path_lower: '/sku001_05.jpg' },
      ];

      const result = groupProductsFromDropbox(entries);
      
      expect(result[0].gallery).toHaveLength(4);
    });

    it('should handle empty entries array', () => {
      const result = groupProductsFromDropbox([]);
      expect(result).toEqual([]);
    });

    it('should handle entries with extra properties', () => {
      const entries = [
        { name: 'SKU001_01.jpg', path_lower: '/sku001_01.jpg', size: 1024, modified: '2024-01-01' },
        { name: 'SKU001_02.jpg', path_lower: '/sku001_02.jpg', size: 2048, modified: '2024-01-02' },
      ];

      const result = groupProductsFromDropbox(entries);
      
      expect(result[0].main).toHaveProperty('size', 1024);
      expect(result[0].gallery[0]).toHaveProperty('size', 2048);
    });

    it('should handle mixed SKUs', () => {
      const entries = [
        { name: 'ABC_01.jpg', path_lower: '/abc_01.jpg' },
        { name: 'ABC_02.jpg', path_lower: '/abc_02.jpg' },
        { name: 'XYZ_01.jpg', path_lower: '/xyz_01.jpg' },
        { name: 'XYZ_price.jpg', path_lower: '/xyz_price.jpg' },
        { name: '123_01.jpg', path_lower: '/123_01.jpg' },
      ];

      const result = groupProductsFromDropbox(entries);
      
      expect(result).toHaveLength(3);
      expect(result.map(g => g.sku)).toContain('ABC');
      expect(result.map(g => g.sku)).toContain('XYZ');
      expect(result.map(g => g.sku)).toContain('123');
    });

    it('should handle underscore in SKU name', () => {
      const entries = [
        { name: 'SKU_PROD_01.jpg', path_lower: '/sku_prod_01.jpg' },
        { name: 'SKU_PROD_02.jpg', path_lower: '/sku_prod_02.jpg' },
      ];

      const result = groupProductsFromDropbox(entries);
      
      // Split on all underscores: prefix='SKU', suffix='PROD_01' which starts with 'PROD'
      // Does not match _01 pattern, so no main image found
      expect(result).toHaveLength(0);
    });

    it('should not add _01 to gallery', () => {
      const entries = [
        { name: 'SKU001_01.jpg', path_lower: '/sku001_01.jpg' },
        { name: 'SKU001_02.jpg', path_lower: '/sku001_02.jpg' },
      ];

      const result = groupProductsFromDropbox(entries);
      
      expect(result[0].gallery).not.toContain(entries[0]);
      expect(result[0].gallery).toContain(entries[1]);
    });

    it('should not add _price to gallery', () => {
      const entries = [
        { name: 'SKU001_01.jpg', path_lower: '/sku001_01.jpg' },
        { name: 'SKU001_price.jpg', path_lower: '/sku001_price.jpg' },
        { name: 'SKU001_02.jpg', path_lower: '/sku001_02.jpg' },
      ];

      const result = groupProductsFromDropbox(entries);
      
      expect(result[0].gallery).toHaveLength(1);
      expect(result[0].gallery).toContain(entries[2]);
      expect(result[0].gallery).not.toContain(entries[1]);
    });
  });
});
