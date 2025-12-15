/**
 * Comprehensive tests for utils/displayUrl.ts
 * Target: 100% code coverage
 */

import { makeDisplayUrl } from '../../src/utils/displayUrl';

// Mock the toDirectDropbox import
jest.mock('../../src/lib/merge', () => ({
  toDirectDropbox: jest.fn((url: string) => {
    // Simulate Dropbox URL normalization
    if (url.includes('dropbox.com') || url.includes('dropboxusercontent.com')) {
      return url.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace('?dl=0', '').replace('?dl=1', '');
    }
    return url;
  }),
}));

describe('displayUrl.ts', () => {
  describe('makeDisplayUrl', () => {
    it('should normalize Dropbox URLs', () => {
      const result = makeDisplayUrl('https://www.dropbox.com/s/abc123/file.jpg?dl=0', 'file.jpg');
      // toDirectDropbox converts to dl.dropboxusercontent.com
      expect(result).toBe('https://dl.dropboxusercontent.com/s/abc123/file.jpg');
    });

    it('should return normalized URL for valid https URL', () => {
      const result = makeDisplayUrl('https://example.com/image.jpg', 'image.jpg');
      expect(result).toBe('https://example.com/image.jpg');
    });

    it('should return normalized URL for valid http URL', () => {
      const result = makeDisplayUrl('http://example.com/photo.png', 'photo.png');
      expect(result).toBe('http://example.com/photo.png');
    });

    it('should return basename when originalUrl is empty', () => {
      expect(makeDisplayUrl('', 'image.jpg')).toBe('image.jpg');
    });

    it('should return originalUrl when normalization does not produce full URL', () => {
      const result = makeDisplayUrl('relative/path/image.jpg', 'image.jpg');
      expect(result).toBe('relative/path/image.jpg');
    });

    it('should handle just filename', () => {
      const result = makeDisplayUrl('image.jpg', 'image.jpg');
      expect(result).toBe('image.jpg');
    });

    it('should handle full Dropbox URLs', () => {
      const url = 'https://dl.dropboxusercontent.com/scl/fo/abc/file.jpg';
      const result = makeDisplayUrl(url, 'file.jpg');
      expect(result).toBe(url);
    });

    it('should preserve query parameters after normalization', () => {
      const url = 'https://example.com/image.jpg?param=value';
      const result = makeDisplayUrl(url, 'image.jpg');
      expect(result).toBe('https://example.com/image.jpg?param=value');
    });

    it('should handle URLs with special characters', () => {
      const url = 'https://example.com/image%20with%20spaces.jpg';
      const result = makeDisplayUrl(url, 'image with spaces.jpg');
      expect(result).toBe('https://example.com/image%20with%20spaces.jpg');
    });
  });
});
