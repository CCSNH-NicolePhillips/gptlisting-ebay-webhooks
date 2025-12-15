describe('clip-cache', () => {
  let mockFetch: jest.Mock;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    
    // Set up env vars
    process.env.UPSTASH_REDIS_REST_URL = 'https://test-redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

    // Mock fetch globally
    mockFetch = jest.fn();
    global.fetch = mockFetch;

    // Spy on console.warn to suppress and test warnings
    consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  describe('module initialization', () => {
    it('should warn if Upstash credentials missing', () => {
      delete process.env.UPSTASH_REDIS_REST_URL;
      jest.resetModules();
      require('../../src/lib/clip-cache');
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('CLIP cache disabled')
      );
    });

    it('should not warn if credentials present', () => {
      jest.resetModules();
      require('../../src/lib/clip-cache');
      
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe('getCached', () => {
    it('should retrieve and parse cached vector', async () => {
      const { getCached } = require('../../src/lib/clip-cache');
      
      const vector = [0.1, 0.2, 0.3, 0.4];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(vector) }),
      });

      const result = await getCached('test-key');

      expect(result).toEqual(vector);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-redis.upstash.io/GET/test-key',
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer test-token' },
        })
      );
    });

    it('should return null when key not found', async () => {
      const { getCached } = require('../../src/lib/clip-cache');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      });

      const result = await getCached('missing-key');

      expect(result).toBeNull();
    });

    it('should return null on invalid JSON', async () => {
      const { getCached } = require('../../src/lib/clip-cache');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'invalid json {' }),
      });

      const result = await getCached('bad-key');

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        '[clip-cache] parse error',
        expect.any(Error)
      );
    });

    it('should return null on HTTP error', async () => {
      const { getCached } = require('../../src/lib/clip-cache');
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });

      const result = await getCached('error-key');

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        '[clip-cache] Upstash error',
        500
      );
    });

    it('should return null on network error', async () => {
      const { getCached } = require('../../src/lib/clip-cache');
      
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await getCached('network-fail');

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        '[clip-cache] call failed',
        expect.any(Error)
      );
    });

    it('should return null when credentials missing', async () => {
      delete process.env.UPSTASH_REDIS_REST_URL;
      const { getCached } = require('../../src/lib/clip-cache');

      const result = await getCached('test-key');

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle non-string result', async () => {
      const { getCached } = require('../../src/lib/clip-cache');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 12345 }),
      });

      const result = await getCached('numeric-result');

      expect(result).toBeNull();
    });

    it('should handle empty string result', async () => {
      const { getCached } = require('../../src/lib/clip-cache');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: '' }),
      });

      const result = await getCached('empty-result');

      expect(result).toBeNull();
    });
  });

  describe('putCached', () => {
    it('should store vector with default TTL', async () => {
      const { putCached } = require('../../src/lib/clip-cache');
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: 'OK' }),
      });

      const vector = [0.5, 0.6, 0.7];
      await putCached('test-key', vector);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      
      // First call: SET
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('/SET/test-key/'),
        expect.any(Object)
      );
      
      const setUrl = mockFetch.mock.calls[0][0];
      expect(setUrl).toContain(encodeURIComponent(JSON.stringify(vector)));

      // Second call: EXPIRE with default TTL (30 days)
      const defaultTTL = 30 * 24 * 60 * 60;
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        `https://test-redis.upstash.io/EXPIRE/test-key/${defaultTTL}`,
        expect.any(Object)
      );
    });

    it('should store vector with custom TTL', async () => {
      const { putCached } = require('../../src/lib/clip-cache');
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: 'OK' }),
      });

      const vector = [1.0, 2.0];
      await putCached('custom-ttl', vector, 3600);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      
      // EXPIRE with custom TTL
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'https://test-redis.upstash.io/EXPIRE/custom-ttl/3600',
        expect.any(Object)
      );
    });

    it('should not call Redis when credentials missing', async () => {
      delete process.env.UPSTASH_REDIS_REST_URL;
      const { putCached } = require('../../src/lib/clip-cache');

      await putCached('test-key', [1, 2, 3]);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should use Bearer token for authorization', async () => {
      const { putCached } = require('../../src/lib/clip-cache');
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: 'OK' }),
      });

      await putCached('auth-test', [0.1]);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-token' },
        })
      );
    });

    it('should handle trailing slash in BASE URL', async () => {
      process.env.UPSTASH_REDIS_REST_URL = 'https://test-redis.upstash.io/';
      const { putCached } = require('../../src/lib/clip-cache');
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: 'OK' }),
      });

      await putCached('slash-test', [1]);

      const url = mockFetch.mock.calls[0][0];
      const pathPart = url.replace('https://', '');
      expect(pathPart).not.toContain('//');
    });
  });

  describe('textKey', () => {
    it('should generate consistent SHA1 hash for text', () => {
      const { textKey } = require('../../src/lib/clip-cache');
      
      const key1 = textKey('hello world');
      const key2 = textKey('hello world');
      
      expect(key1).toBe(key2);
      expect(key1).toMatch(/^cliptxt:[a-f0-9]{40}$/);
    });

    it('should generate different hashes for different text', () => {
      const { textKey } = require('../../src/lib/clip-cache');
      
      const key1 = textKey('text A');
      const key2 = textKey('text B');
      
      expect(key1).not.toBe(key2);
    });

    it('should handle empty string', () => {
      const { textKey } = require('../../src/lib/clip-cache');
      
      const key = textKey('');
      
      expect(key).toMatch(/^cliptxt:[a-f0-9]{40}$/);
    });

    it('should handle special characters', () => {
      const { textKey } = require('../../src/lib/clip-cache');
      
      const key = textKey('Hello 世界! @#$%');
      
      expect(key).toMatch(/^cliptxt:[a-f0-9]{40}$/);
    });
  });

  describe('imageKey', () => {
    it('should generate consistent SHA1 hash for URL', () => {
      const { imageKey } = require('../../src/lib/clip-cache');
      
      const key1 = imageKey('https://example.com/image.jpg');
      const key2 = imageKey('https://example.com/image.jpg');
      
      expect(key1).toBe(key2);
      expect(key1).toMatch(/^clipimg:[a-f0-9]{40}$/);
    });

    it('should generate different hashes for different URLs', () => {
      const { imageKey } = require('../../src/lib/clip-cache');
      
      const key1 = imageKey('https://example.com/a.jpg');
      const key2 = imageKey('https://example.com/b.jpg');
      
      expect(key1).not.toBe(key2);
    });

    it('should handle query parameters in URL', () => {
      const { imageKey } = require('../../src/lib/clip-cache');
      
      const key = imageKey('https://example.com/image.jpg?size=large&v=2');
      
      expect(key).toMatch(/^clipimg:[a-f0-9]{40}$/);
    });
  });
});
