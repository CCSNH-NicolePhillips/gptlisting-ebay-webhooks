/**
 * Unit tests for bind-store.ts
 * Tests Upstash Redis binding storage
 */

// Mock fetch globally
global.fetch = jest.fn();

describe('bind-store', () => {
  const originalEnv = {
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules(); // Reset modules to reload with new env
    process.env.UPSTASH_REDIS_REST_URL = 'https://test-redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  });

  afterEach(() => {
    // Restore original env
    process.env.UPSTASH_REDIS_REST_URL = originalEnv.UPSTASH_REDIS_REST_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = originalEnv.UPSTASH_REDIS_REST_TOKEN;
  });

  describe('putBinding', () => {
    it('should store a binding with correct key and payload', async () => {
      const { putBinding } = require('../../src/lib/bind-store');
      const mockFetch = global.fetch as jest.Mock;
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: 'OK' }),
      });

      const payload = { data: 'test-data', value: 123 };
      const result = await putBinding('user1', 'job1', 'group1', payload);

      expect(result).toBe('map:user1:job1:group1');
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('https://test-redis.upstash.io/SET/map%3Auser1%3Ajob1%3Agroup1/');
      // Value is URL-encoded JSON in the path
      expect(url).toContain('%22data%22');
      expect(url).toContain('%22value%22');
      expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.any(Object));

      const callArgs = mockFetch.mock.calls[0];
      const body = callArgs[0];
      expect(body).toContain('map%3Auser1%3Ajob1%3Agroup1');
    });

    it('should include updatedAt timestamp in payload', async () => {
      const { putBinding } = require('../../src/lib/bind-store');
      const mockFetch = global.fetch as jest.Mock;
      const mockJson = jest.fn().mockResolvedValue({ result: 'OK' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: mockJson,
      });

      const beforeTime = Date.now();
      await putBinding('user1', 'job1', 'group1', { data: 'test' });
      const afterTime = Date.now();

      expect(mockFetch).toHaveBeenCalled();
      const url = mockFetch.mock.calls[0][0];
      
      // Check that the URL contains encoded JSON with data and updatedAt
      expect(url).toContain('data');
      expect(url).toContain('updatedAt');
    });

    it('should use Bearer token for authorization', async () => {
      const { putBinding } = require('../../src/lib/bind-store');
      const mockFetch = global.fetch as jest.Mock;
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: 'OK' }),
      });

      await putBinding('user1', 'job1', 'group1', {});

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer test-token' },
        })
      );
    });

    it('should throw when Upstash URL is not configured', async () => {
      delete process.env.UPSTASH_REDIS_REST_URL;
      const { putBinding } = require('../../src/lib/bind-store');

      await expect(putBinding('user1', 'job1', 'group1', {}))
        .rejects.toThrow('Upstash not configured');
    });

    it('should throw when Upstash token is not configured', async () => {
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      const { putBinding } = require('../../src/lib/bind-store');

      await expect(putBinding('user1', 'job1', 'group1', {}))
        .rejects.toThrow('Upstash not configured');
    });

    it('should throw on HTTP error response', async () => {
      const { putBinding } = require('../../src/lib/bind-store');
      const mockFetch = global.fetch as jest.Mock;
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      await expect(putBinding('user1', 'job1', 'group1', {}))
        .rejects.toThrow('Upstash 500: Internal Server Error');
    });

    it('should handle trailing slash in BASE URL', async () => {
      process.env.UPSTASH_REDIS_REST_URL = 'https://test-redis.upstash.io/';
      const { putBinding } = require('../../src/lib/bind-store');
      
      const mockFetch = global.fetch as jest.Mock;
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: 'OK' }),
      });

      await putBinding('user1', 'job1', 'group1', {});

      const url = mockFetch.mock.calls[0][0];
      // Even with trailing slash input, BASE strips it so URL is correct
      expect(url).toContain('https://test-redis.upstash.io/SET');
      // Verify no double slashes in path (after protocol)
      const pathPart = url.replace('https://', '');
      expect(pathPart).not.toContain('//');
    });
  });

  describe('getBindingsForJob', () => {
    it('should retrieve all bindings for a job', async () => {
      const { getBindingsForJob } = require('../../src/lib/bind-store');
      const mockFetch = global.fetch as jest.Mock;
      
      // First call: KEYS pattern match
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ 
          result: ['map:user1:job1:group1', 'map:user1:job1:group2'] 
        }),
      });

      // Second call: GET first key
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ 
          result: JSON.stringify({ data: 'binding1', updatedAt: 123 })
        }),
      });

      // Third call: GET second key
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ 
          result: JSON.stringify({ data: 'binding2', updatedAt: 456 })
        }),
      });

      const result = await getBindingsForJob('user1', 'job1');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ data: 'binding1', updatedAt: 123 });
      expect(result[1]).toEqual({ data: 'binding2', updatedAt: 456 });
    });

    it('should use correct KEYS pattern', async () => {
      const { getBindingsForJob } = require('../../src/lib/bind-store');
      const mockFetch = global.fetch as jest.Mock;
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: [] }),
      });

      await getBindingsForJob('user1', 'job1');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('KEYS/map%3Auser1%3Ajob1%3A*'),
        expect.any(Object)
      );
    });

    it('should return empty array when no keys found', async () => {
      const { getBindingsForJob } = require('../../src/lib/bind-store');
      const mockFetch = global.fetch as jest.Mock;
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: [] }),
      });

      const result = await getBindingsForJob('user1', 'job1');

      expect(result).toEqual([]);
    });

    it('should return empty array when KEYS returns non-array', async () => {
      const { getBindingsForJob } = require('../../src/lib/bind-store');
      const mockFetch = global.fetch as jest.Mock;
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: null }),
      });

      const result = await getBindingsForJob('user1', 'job1');

      expect(result).toEqual([]);
    });

    it('should skip invalid JSON entries with warning', async () => {
      const { getBindingsForJob } = require('../../src/lib/bind-store');
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const mockFetch = global.fetch as jest.Mock;
      
      // KEYS returns one key
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: ['map:user1:job1:group1'] }),
      });

      // GET returns invalid JSON
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'invalid json {' }),
      });

      const result = await getBindingsForJob('user1', 'job1');

      expect(result).toEqual([]);
      expect(consoleSpy).toHaveBeenCalledWith(
        '[bind-store] failed to parse binding',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });

    it('should skip null or empty GET results', async () => {
      const { getBindingsForJob } = require('../../src/lib/bind-store');
      const mockFetch = global.fetch as jest.Mock;
      
      // KEYS returns keys
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ 
          result: ['map:user1:job1:group1', 'map:user1:job1:group2'] 
        }),
      });

      // GET returns null
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      });

      // GET returns empty string
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: '' }),
      });

      const result = await getBindingsForJob('user1', 'job1');

      expect(result).toEqual([]);
    });

    it('should skip non-string GET results', async () => {
      const { getBindingsForJob } = require('../../src/lib/bind-store');
      const mockFetch = global.fetch as jest.Mock;
      
      // KEYS returns one key
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: ['map:user1:job1:group1'] }),
      });

      // GET returns a number instead of string
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 12345 }),
      });

      const result = await getBindingsForJob('user1', 'job1');

      expect(result).toEqual([]);
    });

    it('should handle fetch errors gracefully', async () => {
      const { getBindingsForJob } = require('../../src/lib/bind-store');
      const mockFetch = global.fetch as jest.Mock;
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(getBindingsForJob('user1', 'job1'))
        .rejects.toThrow('Network error');
    });

    it('should handle JSON parse errors in response', async () => {
      const { getBindingsForJob } = require('../../src/lib/bind-store');
      const mockFetch = global.fetch as jest.Mock;
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => { throw new Error('Invalid JSON'); },
      });

      const result = await getBindingsForJob('user1', 'job1');

      // Should return null result, which becomes empty array
      expect(result).toEqual([]);
    });

    it('should URL-encode special characters in keys', async () => {
      const { getBindingsForJob } = require('../../src/lib/bind-store');
      const mockFetch = global.fetch as jest.Mock;
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: [] }),
      });

      await getBindingsForJob('user@email.com', 'job/123');

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('user%40email.com');
      expect(url).toContain('job%2F123');
    });
  });
});
