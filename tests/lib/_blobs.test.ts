// Set up environment before any imports
process.env.NETLIFY_BLOBS_SITE_ID = '';
process.env.NETLIFY_BLOBS_TOKEN = '';
process.env.BLOBS_SITE_ID = '';
process.env.BLOBS_TOKEN = '';

// Mock @netlify/blobs
const mockGetStore = jest.fn();
jest.mock('@netlify/blobs', () => ({
  getStore: mockGetStore
}));

import { tokensStore, cacheStore } from '../../src/lib/_blobs';

describe('_blobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset environment variables
    delete process.env.NETLIFY_BLOBS_SITE_ID;
    delete process.env.NETLIFY_BLOBS_TOKEN;
    delete process.env.BLOBS_SITE_ID;
    delete process.env.BLOBS_TOKEN;
  });

  describe('tokensStore', () => {
    it('should call getStore with "tokens" name when no credentials provided', () => {
      tokensStore();

      expect(mockGetStore).toHaveBeenCalledWith('tokens');
    });

    it('should use NETLIFY_BLOBS_SITE_ID and NETLIFY_BLOBS_TOKEN when provided', () => {
      process.env.NETLIFY_BLOBS_SITE_ID = 'netlify-site-123';
      process.env.NETLIFY_BLOBS_TOKEN = 'netlify-token-456';

      tokensStore();

      expect(mockGetStore).toHaveBeenCalledWith({
        name: 'tokens',
        siteID: 'netlify-site-123',
        token: 'netlify-token-456'
      });
    });

    it('should use BLOBS_SITE_ID and BLOBS_TOKEN when NETLIFY_ prefixed vars not set', () => {
      process.env.BLOBS_SITE_ID = 'blobs-site-789';
      process.env.BLOBS_TOKEN = 'blobs-token-012';

      tokensStore();

      expect(mockGetStore).toHaveBeenCalledWith({
        name: 'tokens',
        siteID: 'blobs-site-789',
        token: 'blobs-token-012'
      });
    });

    it('should prioritize NETLIFY_ prefixed vars over non-prefixed vars', () => {
      process.env.NETLIFY_BLOBS_SITE_ID = 'netlify-site';
      process.env.NETLIFY_BLOBS_TOKEN = 'netlify-token';
      process.env.BLOBS_SITE_ID = 'blobs-site';
      process.env.BLOBS_TOKEN = 'blobs-token';

      tokensStore();

      expect(mockGetStore).toHaveBeenCalledWith({
        name: 'tokens',
        siteID: 'netlify-site',
        token: 'netlify-token'
      });
    });

    it('should fall back to default when only siteID is provided', () => {
      process.env.NETLIFY_BLOBS_SITE_ID = 'netlify-site';

      tokensStore();

      expect(mockGetStore).toHaveBeenCalledWith('tokens');
    });

    it('should fall back to default when only token is provided', () => {
      process.env.NETLIFY_BLOBS_TOKEN = 'netlify-token';

      tokensStore();

      expect(mockGetStore).toHaveBeenCalledWith('tokens');
    });

    it('should handle mixed prefix vars (NETLIFY_SITE_ID + BLOBS_TOKEN)', () => {
      process.env.NETLIFY_BLOBS_SITE_ID = 'netlify-site';
      process.env.BLOBS_TOKEN = 'blobs-token';

      tokensStore();

      expect(mockGetStore).toHaveBeenCalledWith({
        name: 'tokens',
        siteID: 'netlify-site',
        token: 'blobs-token'
      });
    });

    it('should handle mixed prefix vars (BLOBS_SITE_ID + NETLIFY_TOKEN)', () => {
      process.env.BLOBS_SITE_ID = 'blobs-site';
      process.env.NETLIFY_BLOBS_TOKEN = 'netlify-token';

      tokensStore();

      expect(mockGetStore).toHaveBeenCalledWith({
        name: 'tokens',
        siteID: 'blobs-site',
        token: 'netlify-token'
      });
    });

    it('should return the result from getStore', () => {
      const mockStore = { get: jest.fn(), set: jest.fn() };
      mockGetStore.mockReturnValue(mockStore);

      const result = tokensStore();

      expect(result).toBe(mockStore);
    });

    it('should handle empty string values as falsy', () => {
      process.env.NETLIFY_BLOBS_SITE_ID = '';
      process.env.NETLIFY_BLOBS_TOKEN = '';

      tokensStore();

      expect(mockGetStore).toHaveBeenCalledWith('tokens');
    });

    it('should handle whitespace-only values', () => {
      process.env.NETLIFY_BLOBS_SITE_ID = '   ';
      process.env.NETLIFY_BLOBS_TOKEN = '   ';

      tokensStore();

      // Whitespace strings are truthy, so it will use them
      expect(mockGetStore).toHaveBeenCalledWith({
        name: 'tokens',
        siteID: '   ',
        token: '   '
      });
    });
  });

  describe('cacheStore', () => {
    it('should call getStore with "cache" name when no credentials provided', () => {
      cacheStore();

      expect(mockGetStore).toHaveBeenCalledWith('cache');
    });

    it('should use NETLIFY_BLOBS_SITE_ID and NETLIFY_BLOBS_TOKEN when provided', () => {
      process.env.NETLIFY_BLOBS_SITE_ID = 'netlify-site-123';
      process.env.NETLIFY_BLOBS_TOKEN = 'netlify-token-456';

      cacheStore();

      expect(mockGetStore).toHaveBeenCalledWith({
        name: 'cache',
        siteID: 'netlify-site-123',
        token: 'netlify-token-456'
      });
    });

    it('should use BLOBS_SITE_ID and BLOBS_TOKEN when NETLIFY_ prefixed vars not set', () => {
      process.env.BLOBS_SITE_ID = 'blobs-site-789';
      process.env.BLOBS_TOKEN = 'blobs-token-012';

      cacheStore();

      expect(mockGetStore).toHaveBeenCalledWith({
        name: 'cache',
        siteID: 'blobs-site-789',
        token: 'blobs-token-012'
      });
    });

    it('should prioritize NETLIFY_ prefixed vars over non-prefixed vars', () => {
      process.env.NETLIFY_BLOBS_SITE_ID = 'netlify-site';
      process.env.NETLIFY_BLOBS_TOKEN = 'netlify-token';
      process.env.BLOBS_SITE_ID = 'blobs-site';
      process.env.BLOBS_TOKEN = 'blobs-token';

      cacheStore();

      expect(mockGetStore).toHaveBeenCalledWith({
        name: 'cache',
        siteID: 'netlify-site',
        token: 'netlify-token'
      });
    });

    it('should fall back to default when only siteID is provided', () => {
      process.env.NETLIFY_BLOBS_SITE_ID = 'netlify-site';

      cacheStore();

      expect(mockGetStore).toHaveBeenCalledWith('cache');
    });

    it('should fall back to default when only token is provided', () => {
      process.env.NETLIFY_BLOBS_TOKEN = 'netlify-token';

      cacheStore();

      expect(mockGetStore).toHaveBeenCalledWith('cache');
    });

    it('should return the result from getStore', () => {
      const mockStore = { get: jest.fn(), set: jest.fn() };
      mockGetStore.mockReturnValue(mockStore);

      const result = cacheStore();

      expect(result).toBe(mockStore);
    });

    it('should handle empty string values as falsy', () => {
      process.env.NETLIFY_BLOBS_SITE_ID = '';
      process.env.NETLIFY_BLOBS_TOKEN = '';

      cacheStore();

      expect(mockGetStore).toHaveBeenCalledWith('cache');
    });
  });

  describe('tokensStore and cacheStore behavior', () => {
    it('should create different stores for different names', () => {
      process.env.NETLIFY_BLOBS_SITE_ID = 'site-123';
      process.env.NETLIFY_BLOBS_TOKEN = 'token-456';

      tokensStore();
      cacheStore();

      expect(mockGetStore).toHaveBeenCalledTimes(2);
      expect(mockGetStore).toHaveBeenNthCalledWith(1, {
        name: 'tokens',
        siteID: 'site-123',
        token: 'token-456'
      });
      expect(mockGetStore).toHaveBeenNthCalledWith(2, {
        name: 'cache',
        siteID: 'site-123',
        token: 'token-456'
      });
    });

    it('should handle sequential calls with changing environment', () => {
      // First call with no credentials
      tokensStore();
      expect(mockGetStore).toHaveBeenLastCalledWith('tokens');

      // Set credentials
      process.env.NETLIFY_BLOBS_SITE_ID = 'site-123';
      process.env.NETLIFY_BLOBS_TOKEN = 'token-456';

      // Second call with credentials
      tokensStore();
      expect(mockGetStore).toHaveBeenLastCalledWith({
        name: 'tokens',
        siteID: 'site-123',
        token: 'token-456'
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle undefined environment variables', () => {
      delete process.env.NETLIFY_BLOBS_SITE_ID;
      delete process.env.NETLIFY_BLOBS_TOKEN;
      delete process.env.BLOBS_SITE_ID;
      delete process.env.BLOBS_TOKEN;

      tokensStore();

      expect(mockGetStore).toHaveBeenCalledWith('tokens');
    });

    it('should handle very long credential strings', () => {
      const longSiteId = 'a'.repeat(1000);
      const longToken = 'b'.repeat(1000);
      process.env.NETLIFY_BLOBS_SITE_ID = longSiteId;
      process.env.NETLIFY_BLOBS_TOKEN = longToken;

      tokensStore();

      expect(mockGetStore).toHaveBeenCalledWith({
        name: 'tokens',
        siteID: longSiteId,
        token: longToken
      });
    });

    it('should handle special characters in credentials', () => {
      process.env.NETLIFY_BLOBS_SITE_ID = 'site-123!@#$%';
      process.env.NETLIFY_BLOBS_TOKEN = 'token-456&*()';

      tokensStore();

      expect(mockGetStore).toHaveBeenCalledWith({
        name: 'tokens',
        siteID: 'site-123!@#$%',
        token: 'token-456&*()'
      });
    });

    it('should handle numeric-looking string credentials', () => {
      process.env.NETLIFY_BLOBS_SITE_ID = '12345';
      process.env.NETLIFY_BLOBS_TOKEN = '67890';

      cacheStore();

      expect(mockGetStore).toHaveBeenCalledWith({
        name: 'cache',
        siteID: '12345',
        token: '67890'
      });
    });
  });
});
