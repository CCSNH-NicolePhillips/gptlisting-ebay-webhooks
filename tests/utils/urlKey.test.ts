/**
 * Comprehensive tests for utils/urlKey.ts
 * Target: 100% code coverage
 */

import { urlKey } from '../../src/utils/urlKey';

describe('urlKey.ts', () => {
  describe('urlKey', () => {
    it('should return basename only', () => {
      expect(urlKey('asd32q.jpg')).toBe('asd32q.jpg');
      expect(urlKey('photo.png')).toBe('photo.png');
    });

    it('should extract basename from path', () => {
      expect(urlKey('EBAY/awef.jpg')).toBe('awef.jpg');
      expect(urlKey('folder/subfolder/image.jpg')).toBe('image.jpg');
    });

    it('should strip EBAY_ prefix', () => {
      expect(urlKey('EBAY_frog_01.jpg')).toBe('frog_01.jpg');
      expect(urlKey('ebay_test.png')).toBe('test.png');
    });

    it('should strip EBAY- prefix', () => {
      expect(urlKey('EBAY-awefawed.jpg')).toBe('awefawed.jpg');
      expect(urlKey('ebay-photo.png')).toBe('photo.png');
    });

    it('should strip query parameters', () => {
      expect(urlKey('https://dl.dropbox.com/awef.jpg?rlkey=abc123')).toBe('awef.jpg');
      expect(urlKey('image.jpg?param=value&other=test')).toBe('image.jpg');
    });

    it('should handle full Dropbox URLs', () => {
      expect(urlKey('https://dl.dropboxusercontent.com/scl/fo/abc/file.jpg?rlkey=xyz')).toBe('file.jpg');
      expect(urlKey('https://www.dropbox.com/s/abc123/photo.png?dl=0')).toBe('photo.png');
    });

    it('should convert to lowercase', () => {
      expect(urlKey('PHOTO.JPG')).toBe('photo.jpg');
      expect(urlKey('MixedCase.PNG')).toBe('mixedcase.png');
    });

    it('should handle pipe separator (EBAY | filename)', () => {
      expect(urlKey('EBAY | x.jpg')).toBe('x.jpg');
      expect(urlKey('EBAY|photo.png')).toBe('photo.png');
      expect(urlKey('folder | subfolder | file.jpg')).toBe('file.jpg');
    });

    it('should trim whitespace', () => {
      expect(urlKey('  photo.jpg  ')).toBe('photo.jpg');
      expect(urlKey('  EBAY_test.png  ')).toBe('test.png');
    });

    it('should handle empty/null values', () => {
      expect(urlKey('')).toBe('');
      expect(urlKey('   ')).toBe('');
    });

    it('should handle URLs without filename', () => {
      // Returns base (last part) if no filename, lowercased
      expect(urlKey('https://example.com/')).toBe('https://example.com/');
      expect(urlKey('folder/')).toBe('folder/');
    });

    it('should handle just filename without path', () => {
      expect(urlKey('simple.jpg')).toBe('simple.jpg');
      expect(urlKey('EBAY_simple.jpg')).toBe('simple.jpg');
    });

    it('should handle multiple EBAY prefixes', () => {
      expect(urlKey('ebay_ebay_test.jpg')).toBe('ebay_test.jpg'); // Only strips first
      expect(urlKey('EBAY-EBAY-photo.png')).toBe('ebay-photo.png');
    });

    it('should handle case insensitive EBAY prefix', () => {
      expect(urlKey('EbAy_test.jpg')).toBe('test.jpg');
      expect(urlKey('eBaY-photo.png')).toBe('photo.png');
    });

    it('should handle combined transformations', () => {
      expect(urlKey('  EBAY | EBAY_Photo.JPG?param=value  ')).toBe('photo.jpg');
      expect(urlKey('https://example.com/EBAY-Test.PNG?x=1&y=2')).toBe('test.png');
    });
  });
});
