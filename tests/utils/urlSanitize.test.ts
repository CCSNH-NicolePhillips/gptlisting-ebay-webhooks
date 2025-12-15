/**
 * Comprehensive tests for utils/urlSanitize.ts
 * Target: 100% code coverage
 */

import { sanitizeInsightUrl } from '../../src/utils/urlSanitize';

describe('urlSanitize.ts', () => {
  describe('sanitizeInsightUrl', () => {
    it('should return URL when valid', () => {
      expect(sanitizeInsightUrl('https://example.com/image.jpg')).toBe('https://example.com/image.jpg');
      expect(sanitizeInsightUrl('http://test.com/photo.png')).toBe('http://test.com/photo.png');
    });

    it('should return fallback for <imgUrl> placeholder', () => {
      expect(sanitizeInsightUrl('<imgUrl>', 'https://fallback.com/image.jpg')).toBe('https://fallback.com/image.jpg');
    });

    it('should return fallback for <imgurl> placeholder (lowercase)', () => {
      expect(sanitizeInsightUrl('<imgurl>', 'https://fallback.com/photo.png')).toBe('https://fallback.com/photo.png');
    });

    it('should return fallback for any <...> pattern', () => {
      expect(sanitizeInsightUrl('<placeholder>', 'https://fallback.com/test.jpg')).toBe('https://fallback.com/test.jpg');
      expect(sanitizeInsightUrl('<url>', 'https://fallback.com/image.jpg')).toBe('https://fallback.com/image.jpg');
      expect(sanitizeInsightUrl('<image>', 'https://fallback.com/photo.png')).toBe('https://fallback.com/photo.png');
    });

    it('should return empty string for null/undefined with no fallback', () => {
      expect(sanitizeInsightUrl(null)).toBe('');
      expect(sanitizeInsightUrl(undefined)).toBe('');
      expect(sanitizeInsightUrl('')).toBe('');
    });

    it('should return fallback for empty string', () => {
      expect(sanitizeInsightUrl('', 'https://fallback.com/test.jpg')).toBe('https://fallback.com/test.jpg');
    });

    it('should trim whitespace', () => {
      expect(sanitizeInsightUrl('  https://example.com/image.jpg  ')).toBe('https://example.com/image.jpg');
    });

    it('should return fallback for whitespace-only string', () => {
      expect(sanitizeInsightUrl('   ', 'https://fallback.com/image.jpg')).toBe('https://fallback.com/image.jpg');
    });

    it('should handle fallback being undefined', () => {
      expect(sanitizeInsightUrl('<imgUrl>', undefined)).toBe('');
      expect(sanitizeInsightUrl(null, undefined)).toBe('');
    });

    it('should handle normal URLs without fallback', () => {
      expect(sanitizeInsightUrl('https://example.com/test.jpg')).toBe('https://example.com/test.jpg');
    });

    it('should handle paths (not full URLs)', () => {
      expect(sanitizeInsightUrl('/path/to/image.jpg')).toBe('/path/to/image.jpg');
      expect(sanitizeInsightUrl('relative/path.png')).toBe('relative/path.png');
    });

    it('should handle mixed case in placeholder', () => {
      expect(sanitizeInsightUrl('<ImgUrl>', 'https://fallback.com/test.jpg')).toBe('https://fallback.com/test.jpg');
      expect(sanitizeInsightUrl('<IMGURL>', 'https://fallback.com/test.jpg')).toBe('https://fallback.com/test.jpg');
    });

    it('should not match partial angle brackets', () => {
      expect(sanitizeInsightUrl('test<incomplete')).toBe('test<incomplete');
      expect(sanitizeInsightUrl('incomplete>test')).toBe('incomplete>test');
    });

    it('should handle empty fallback', () => {
      expect(sanitizeInsightUrl('<imgUrl>', '')).toBe('');
      expect(sanitizeInsightUrl(null, '')).toBe('');
    });
  });
});
