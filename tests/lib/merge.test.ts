/**
 * Comprehensive tests for merge.ts
 * Target: 100% code coverage
 */

import { toDirectDropbox, sanitizeUrls, mergeGroups } from '../../src/lib/merge';

describe('merge.ts', () => {
  describe('toDirectDropbox', () => {
    it('should convert www.dropbox.com to dl.dropboxusercontent.com', () => {
      const url = 'https://www.dropbox.com/scl/fo/abc123?dl=0';
      const result = toDirectDropbox(url);
      expect(result).toBe('https://dl.dropboxusercontent.com/scl/fo/abc123');
    });

    it('should convert dropbox.com to dl.dropboxusercontent.com', () => {
      const url = 'https://dropbox.com/s/abc123/file.jpg?dl=1';
      const result = toDirectDropbox(url);
      expect(result).toBe('https://dl.dropboxusercontent.com/s/abc123/file.jpg');
    });

    it('should remove ?dl= parameter', () => {
      expect(toDirectDropbox('https://dropbox.com/file?dl=0')).not.toContain('?dl=');
      expect(toDirectDropbox('https://dropbox.com/file?dl=1')).not.toContain('?dl=');
    });

    it('should handle URLs without dl parameter', () => {
      const url = 'https://www.dropbox.com/scl/fo/abc123';
      const result = toDirectDropbox(url);
      expect(result).toBe('https://dl.dropboxusercontent.com/scl/fo/abc123');
    });

    it('should trim whitespace', () => {
      const url = '  https://www.dropbox.com/file  ';
      const result = toDirectDropbox(url);
      expect(result).toBe('https://dl.dropboxusercontent.com/file');
    });

    it('should return empty string for empty input', () => {
      expect(toDirectDropbox('')).toBe('');
    });

    it('should return original URL on error', () => {
      const result = toDirectDropbox(null as any);
      expect(result).toBe(null);
    });

    it('should handle non-Dropbox URLs unchanged', () => {
      const url = 'https://example.com/image.jpg';
      const result = toDirectDropbox(url);
      expect(result).toBe(url);
    });
  });

  describe('sanitizeUrls', () => {
    it('should remove duplicates', () => {
      const urls = ['https://a.com', 'https://b.com', 'https://a.com'];
      const result = sanitizeUrls(urls);
      expect(result).toEqual(['https://a.com', 'https://b.com']);
    });

    it('should trim whitespace', () => {
      const urls = ['  https://a.com  ', 'https://b.com'];
      const result = sanitizeUrls(urls);
      expect(result).toEqual(['https://a.com', 'https://b.com']);
    });

    it('should filter out empty strings', () => {
      const urls = ['https://a.com', '', '   ', 'https://b.com', null as any, undefined as any];
      const result = sanitizeUrls(urls);
      expect(result).toEqual(['https://a.com', 'https://b.com']);
    });

    it('should handle empty array', () => {
      expect(sanitizeUrls([])).toEqual([]);
    });

    it('should handle undefined input', () => {
      expect(sanitizeUrls()).toEqual([]);
    });

    it('should preserve URL order (insertion order)', () => {
      const urls = ['https://c.com', 'https://a.com', 'https://b.com'];
      const result = sanitizeUrls(urls);
      expect(result).toEqual(['https://c.com', 'https://a.com', 'https://b.com']);
    });
  });

  describe('mergeGroups', () => {
    it('should merge empty parts array', () => {
      const result = mergeGroups([]);
      expect(result.groups).toEqual([]);
    });

    it('should handle single group', () => {
      const result = mergeGroups([
        {
          groups: [
            {
              brand: 'TestBrand',
              product: 'TestProduct',
              variant: 'TestVariant',
              images: ['https://example.com/img1.jpg'],
              confidence: 0.9,
            },
          ],
        },
      ]);

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].brand).toBe('TestBrand');
      expect(result.groups[0].product).toBe('TestProduct');
      expect(result.groups[0].groupId).toMatch(/^grp_[a-f0-9]{8}$/);
    });

    it('should create separate entries for groups from different parts', () => {
      const result = mergeGroups([
        {
          groups: [
            {
              brand: 'Brand',
              product: 'Product',
              variant: 'V1',
              images: ['https://example.com/img1.jpg'],
            },
          ],
        },
        {
          groups: [
            {
              brand: 'Brand',
              product: 'Product',
              variant: 'V1',
              images: ['https://example.com/img2.jpg'],
            },
          ],
        },
      ]);

      // Creates 2 entries with _1 and _2 suffixes
      expect(result.groups).toHaveLength(2);
      expect(result.groups[0].images).toContain('https://example.com/img1.jpg');
      expect(result.groups[1].images).toContain('https://example.com/img2.jpg');
    });

    it('should convert Dropbox URLs in images', () => {
      const result = mergeGroups([
        {
          groups: [
            {
              brand: 'Brand',
              product: 'Product',
              images: ['https://www.dropbox.com/file?dl=0'],
            },
          ],
        },
      ]);

      expect(result.groups[0].images[0]).toBe('https://dl.dropboxusercontent.com/file');
    });

    it('should deduplicate images', () => {
      const result = mergeGroups([
        {
          groups: [
            {
              brand: 'Brand',
              product: 'Product',
              images: ['https://example.com/img1.jpg', 'https://example.com/img1.jpg'],
            },
          ],
        },
      ]);

      expect(result.groups[0].images).toEqual(['https://example.com/img1.jpg']);
    });

    it('should merge claims arrays', () => {
      const result = mergeGroups([
        {
          groups: [
            {
              brand: 'Brand',
              product: 'Product',
              claims: ['Claim1', 'Claim2'],
              images: ['https://example.com/img1.jpg'],
            },
          ],
        },
        {
          groups: [
            {
              brand: 'Brand',
              product: 'Product',
              claims: ['Claim2', 'Claim3'],
              images: ['https://example.com/img1.jpg'],
            },
          ],
        },
      ]);

      expect(result.groups[0].claims).toEqual(expect.arrayContaining(['Claim1', 'Claim2', 'Claim3']));
      expect(result.groups[0].claims).toHaveLength(3);
    });

    it('should merge options maps', () => {
      const result = mergeGroups([
        {
          groups: [
            {
              brand: 'Brand',
              product: 'Product',
              options: { size: ['Small'], color: ['Red'] },
              images: ['https://example.com/img1.jpg'],
            },
          ],
        },
        {
          groups: [
            {
              brand: 'Brand',
              product: 'Product',
              options: { size: ['Large'], material: ['Cotton'] },
              images: ['https://example.com/img1.jpg'],
            },
          ],
        },
      ]);

      expect(result.groups[0].options.size).toEqual(expect.arrayContaining(['Small', 'Large']));
      expect(result.groups[0].options.color).toEqual(['Red']);
      expect(result.groups[0].options.material).toEqual(['Cotton']);
    });

    it('should fill in missing brand/product/variant fields', () => {
      const result = mergeGroups([
        {
          groups: [
            {
              product: 'Product',
              images: ['https://example.com/img1.jpg'],
            },
          ],
        },
        {
          groups: [
            {
              brand: 'Brand',
              product: 'Product',
              variant: 'Variant',
              images: ['https://example.com/img1.jpg'],
            },
          ],
        },
      ]);

      expect(result.groups[0].brand).toBe('Brand');
      expect(result.groups[0].variant).toBe('Variant');
    });

    it('should use deeper categoryPath', () => {
      const result = mergeGroups([
        {
          groups: [
            {
              brand: 'Brand',
              product: 'Product',
              categoryPath: 'Category',
              images: ['https://example.com/img1.jpg'],
            },
          ],
        },
        {
          groups: [
            {
              brand: 'Brand',
              product: 'Product',
              categoryPath: 'Category > Subcategory > Item',
              images: ['https://example.com/img1.jpg'],
            },
          ],
        },
      ]);

      expect(result.groups[0].categoryPath).toBe('Category > Subcategory > Item');
    });

    it('should use maximum confidence value', () => {
      const result = mergeGroups([
        {
          groups: [
            {
              brand: 'Brand',
              product: 'Product',
              confidence: 0.7,
              images: ['https://example.com/img1.jpg'],
            },
          ],
        },
        {
          groups: [
            {
              brand: 'Brand',
              product: 'Product',
              confidence: 0.9,
              images: ['https://example.com/img1.jpg'],
            },
          ],
        },
      ]);

      expect(result.groups[0].confidence).toBe(0.9);
    });

    it('should handle primaryImageUrl, heroUrl, backUrl, secondaryImageUrl', () => {
      const result = mergeGroups([
        {
          groups: [
            {
              brand: 'Brand',
              product: 'Product',
              primaryImageUrl: 'https://example.com/primary.jpg',
              heroUrl: 'https://example.com/hero.jpg',
              backUrl: 'https://example.com/back.jpg',
              secondaryImageUrl: 'https://example.com/secondary.jpg',
              images: [],
            },
          ],
        },
      ]);

      expect(result.groups[0].images).toContain('https://example.com/primary.jpg');
      expect(result.groups[0].images).toContain('https://example.com/hero.jpg');
      expect(result.groups[0].images).toContain('https://example.com/back.jpg');
      expect(result.groups[0].images).toContain('https://example.com/secondary.jpg');
    });

    it('should sort groups by brand/product/variant', () => {
      const result = mergeGroups([
        {
          groups: [
            { brand: 'Z', product: 'Z', images: [] },
            { brand: 'A', product: 'A', images: [] },
            { brand: 'M', product: 'M', images: [] },
          ],
        },
      ]);

      expect(result.groups[0].brand).toBe('A');
      expect(result.groups[1].brand).toBe('M');
      expect(result.groups[2].brand).toBe('Z');
    });

    it('should handle groups with no images', () => {
      const result = mergeGroups([
        {
          groups: [
            {
              brand: 'Brand',
              product: 'Product',
            },
          ],
        },
      ]);

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].images).toEqual([]);
    });

    it('should normalize options with undefined/null values', () => {
      const result = mergeGroups([
        {
          groups: [
            {
              brand: 'Brand',
              product: 'Product',
              options: { size: [null, undefined, 'Small', ''] },
              images: [],
            },
          ],
        },
      ]);

      expect(result.groups[0].options.size).toEqual(['Small']);
    });

    it('should add suffix to groupId when multiple groups in same bucket', () => {
      const result = mergeGroups([
        {
          groups: [
            {
              brand: 'Brand',
              product: 'Product',
              variant: 'V1',
              images: ['https://example.com/img1.jpg'],
            },
            {
              brand: 'Brand',
              product: 'Product',
              variant: 'V1',
              images: ['https://example.com/img2.jpg'],
            },
          ],
        },
      ]);

      expect(result.groups).toHaveLength(2);
      expect(result.groups[0].groupId).toMatch(/_1$/);
      expect(result.groups[1].groupId).toMatch(/_2$/);
    });
  });
});
