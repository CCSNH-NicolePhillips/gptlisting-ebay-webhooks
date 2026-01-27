/**
 * Tests for Redis-backed token/cache storage
 * 
 * The _blobs module now uses Upstash Redis REST API for storage.
 * This file tests the RedisStore class behavior via tokensStore() and cacheStore().
 */

// Mock fetch for Redis API calls
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Set up environment before imports
process.env.UPSTASH_REDIS_REST_URL = 'https://test-redis.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token-123';

// Need to reset module cache to apply env vars
jest.resetModules();

describe('_blobs (Redis-backed storage)', () => {
  let tokensStore: () => any;
  let cacheStore: () => any;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();
    
    // Reset singletons by re-importing
    process.env.UPSTASH_REDIS_REST_URL = 'https://test-redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token-123';
    
    const module = await import('../../src/lib/redis-store.js');
    tokensStore = module.tokensStore;
    cacheStore = module.cacheStore;
    
    // Default successful response
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: null }),
      text: () => Promise.resolve(''),
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('tokensStore', () => {
    it('should return a RedisStore instance with correct prefix', () => {
      const store = tokensStore();
      
      expect(store).toBeDefined();
      expect(typeof store.get).toBe('function');
      expect(typeof store.set).toBe('function');
      expect(typeof store.delete).toBe('function');
      expect(typeof store.list).toBe('function');
    });

    it('should return the same singleton instance on multiple calls', () => {
      const store1 = tokensStore();
      const store2 = tokensStore();
      
      expect(store1).toBe(store2);
    });

    it('should use blob:tokens: prefix for keys', async () => {
      const store = tokensStore();
      
      await store.get('my-key');
      
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('blob%3Atokens%3Amy-key'),
        expect.any(Object)
      );
    });
  });

  describe('cacheStore', () => {
    it('should return a RedisStore instance with correct prefix', () => {
      const store = cacheStore();
      
      expect(store).toBeDefined();
      expect(typeof store.get).toBe('function');
      expect(typeof store.set).toBe('function');
      expect(typeof store.delete).toBe('function');
      expect(typeof store.list).toBe('function');
    });

    it('should return the same singleton instance on multiple calls', () => {
      const store1 = cacheStore();
      const store2 = cacheStore();
      
      expect(store1).toBe(store2);
    });

    it('should use blob:cache: prefix for keys', async () => {
      const store = cacheStore();
      
      await store.get('my-cache-key');
      
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('blob%3Acache%3Amy-cache-key'),
        expect.any(Object)
      );
    });
  });

  describe('tokensStore and cacheStore should be different instances', () => {
    it('should return different store instances', () => {
      const tokens = tokensStore();
      const cache = cacheStore();
      
      expect(tokens).not.toBe(cache);
    });
  });

  describe('RedisStore.get()', () => {
    it('should call Redis GET with correct key', async () => {
      const store = tokensStore();
      
      await store.get('oauth-token');
      
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-redis.upstash.io/GET/blob%3Atokens%3Aoauth-token',
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer test-token-123' },
        })
      );
    });

    it('should return null when key does not exist', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: null }),
      });
      
      const store = tokensStore();
      const result = await store.get('non-existent');
      
      expect(result).toBeNull();
    });

    it('should return string value when key exists', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: 'my-value' }),
      });
      
      const store = tokensStore();
      const result = await store.get('my-key');
      
      expect(result).toBe('my-value');
    });

    it('should parse JSON when type is json', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: '{"foo":"bar","num":42}' }),
      });
      
      const store = tokensStore();
      const result = await store.get('json-key', { type: 'json' });
      
      expect(result).toEqual({ foo: 'bar', num: 42 });
    });

    it('should return null for invalid JSON when type is json', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: 'not-valid-json' }),
      });
      
      const store = tokensStore();
      const result = await store.get('bad-json', { type: 'json' });
      
      expect(result).toBeNull();
    });

    it('should return null on Redis error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });
      
      const store = tokensStore();
      const result = await store.get('error-key');
      
      expect(result).toBeNull();
    });

    it('should return null on network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      
      const store = tokensStore();
      const result = await store.get('network-error-key');
      
      expect(result).toBeNull();
    });
  });

  describe('RedisStore.set()', () => {
    it('should call Redis SETEX with correct parameters for tokens store', async () => {
      const store = tokensStore();
      
      await store.set('my-token', 'token-value');
      
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringMatching(/SETEX\/blob%3Atokens%3Amy-token\/\d+\/token-value/),
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer test-token-123' },
        })
      );
    });

    it('should serialize objects to JSON', async () => {
      const store = tokensStore();
      const obj = { access_token: 'abc', refresh_token: 'xyz' };
      
      await store.set('token-obj', obj);
      
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent(JSON.stringify(obj))),
        expect.any(Object)
      );
    });

    it('should use 90-day TTL for tokens store', async () => {
      const store = tokensStore();
      
      await store.set('ttl-test', 'value');
      
      const call = mockFetch.mock.calls[0][0];
      // 90 days = 7776000 seconds
      expect(call).toContain('7776000');
    });

    it('should use 7-day TTL for cache store', async () => {
      const store = cacheStore();
      
      await store.set('cache-ttl-test', 'value');
      
      const call = mockFetch.mock.calls[0][0];
      // 7 days = 604800 seconds
      expect(call).toContain('604800');
    });
  });

  describe('RedisStore.setJSON()', () => {
    it('should serialize object to JSON string', async () => {
      const store = tokensStore();
      const obj = { key: 'value' };
      
      await store.setJSON('json-key', obj);
      
      // setJSON calls JSON.stringify(value), then passes to set()
      // set() checks if value is string - since it is, it uses it directly
      // So the stored value is just the JSON-serialized object
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent(JSON.stringify(obj))),
        expect.any(Object)
      );
    });
  });

  describe('RedisStore.delete()', () => {
    it('should call Redis DEL with correct key', async () => {
      const store = tokensStore();
      
      await store.delete('old-token');
      
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-redis.upstash.io/DEL/blob%3Atokens%3Aold-token',
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer test-token-123' },
        })
      );
    });
  });

  describe('RedisStore.list()', () => {
    it('should call Redis KEYS with pattern', async () => {
      const store = tokensStore();
      
      await store.list();
      
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-redis.upstash.io/KEYS/blob%3Atokens%3A*',
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer test-token-123' },
        })
      );
    });

    it('should return blobs array with keys stripped of prefix', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          result: [
            'blob:tokens:user1',
            'blob:tokens:user2',
            'blob:tokens:user3',
          ],
        }),
      });
      
      const store = tokensStore();
      const result = await store.list();
      
      expect(result).toEqual({
        blobs: [
          { key: 'user1' },
          { key: 'user2' },
          { key: 'user3' },
        ],
      });
    });

    it('should return empty blobs array when no keys exist', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: [] }),
      });
      
      const store = tokensStore();
      const result = await store.list();
      
      expect(result).toEqual({ blobs: [] });
    });

    it('should return empty blobs array on error', async () => {
      mockFetch.mockRejectedValue(new Error('Redis error'));
      
      const store = tokensStore();
      const result = await store.list();
      
      expect(result).toEqual({ blobs: [] });
    });
  });

  describe('Error handling', () => {
    it('should handle missing Redis URL gracefully in get', async () => {
      jest.resetModules();
      delete process.env.UPSTASH_REDIS_REST_URL;
      process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
      
      const module = await import('../../src/lib/redis-store.js');
      const store = module.tokensStore();
      
      const result = await store.get('test');
      expect(result).toBeNull();
    });

    it('should handle missing Redis token gracefully in get', async () => {
      jest.resetModules();
      process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      
      const module = await import('../../src/lib/redis-store.js');
      const store = module.tokensStore();
      
      const result = await store.get('test');
      expect(result).toBeNull();
    });
  });

  describe('Special characters in keys', () => {
    it('should URL-encode special characters in keys', async () => {
      const store = tokensStore();
      
      await store.get('user:123:token');
      
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('blob%3Atokens%3Auser%3A123%3Atoken'),
        expect.any(Object)
      );
    });

    it('should handle keys with slashes', async () => {
      const store = tokensStore();
      
      await store.get('path/to/key');
      
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('blob%3Atokens%3Apath%2Fto%2Fkey'),
        expect.any(Object)
      );
    });
  });
});
