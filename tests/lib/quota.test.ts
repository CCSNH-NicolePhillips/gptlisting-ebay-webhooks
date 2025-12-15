// Set up environment before any imports
process.env.UPSTASH_REDIS_REST_URL = 'https://test-redis.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token-123';
process.env.USER_FREE_IMAGES_PER_DAY = '20';
process.env.USER_MAX_RUNNING_JOBS = '2';

// Mock node-fetch module before imports
const mockFetch = jest.fn();
jest.mock('node-fetch', () => ({
  __esModule: true,
  default: mockFetch
}));

import {
  canConsumeImages,
  consumeImages,
  canStartJob,
  incRunning,
  decRunning
} from '../../src/lib/quota';

describe('quota', () => {
  const mockBase = 'https://test-redis.upstash.io';
  const mockToken = 'test-token-123';

  beforeEach(() => {
    jest.resetAllMocks();
    // Reset to default values
    process.env.UPSTASH_REDIS_REST_URL = mockBase;
    process.env.UPSTASH_REDIS_REST_TOKEN = mockToken;
    process.env.USER_FREE_IMAGES_PER_DAY = '20';
    process.env.USER_MAX_RUNNING_JOBS = '2';
  });

  const mockRedisResponse = (result: any) => {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ result }),
      text: async () => JSON.stringify({ result })
    } as any);
  };

  const mockRedisError = (status: number, message: string) => {
    return Promise.resolve({
      ok: false,
      status,
      text: async () => message
    } as any);
  };

  describe('Configuration', () => {
    // Note: These tests require reloading the module, which is complex in Jest
    // The configuration is read at module load time, so we test that the module
    // is configured correctly via successful API calls

    it('should make successful API calls when configured', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(0));

      const result = await canConsumeImages('user123', 1);

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should include base URL in requests', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(0));

      await canConsumeImages('user123', 1);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringMatching(/^https:\/\/test-redis\.upstash\.io/),
        expect.any(Object)
      );
    });
  });

  describe('canConsumeImages', () => {
    it('should return true when count is 0', async () => {
      const result = await canConsumeImages('user123', 0);

      expect(result).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return true when count is negative', async () => {
      const result = await canConsumeImages('user123', -5);

      expect(result).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return true when under quota', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(10));

      const result = await canConsumeImages('user123', 5);

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should return true when exactly at quota limit', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(15));

      const result = await canConsumeImages('user123', 5);

      expect(result).toBe(true);
    });

    it('should return false when over quota', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(18));

      const result = await canConsumeImages('user123', 5);

      expect(result).toBe(false);
    });

    it('should return true when no existing quota (null)', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(null));

      const result = await canConsumeImages('user123', 5);

      expect(result).toBe(true);
    });

    it('should return true when no existing quota (undefined)', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(undefined));

      const result = await canConsumeImages('user123', 5);

      expect(result).toBe(true);
    });

    it('should use correct day-based key format', async () => {
      const RealDate = Date;
      const mockDate = new RealDate('2025-12-15T10:30:00Z');
      global.Date = class extends RealDate {
        constructor() {
          super();
          return mockDate;
        }
      } as any;

      mockFetch.mockResolvedValueOnce(mockRedisResponse(0));

      await canConsumeImages('user123', 1);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('quota%3Auser123%3A2025-12-15'),
        expect.any(Object)
      );

      global.Date = RealDate;
    });

    it('should pad month and day with zeros', async () => {
      const RealDate = Date;
      const mockDate = new RealDate('2025-01-05T10:30:00Z');
      global.Date = class extends RealDate {
        constructor() {
          super();
          return mockDate;
        }
      } as any;

      mockFetch.mockResolvedValueOnce(mockRedisResponse(0));

      await canConsumeImages('user123', 1);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('quota%3Auser123%3A2025-01-05'),
        expect.any(Object)
      );

      global.Date = RealDate;
    });

    it('should include authorization header', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(0));

      await canConsumeImages('user123', 1);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${mockToken}` }
        }
      );
    });

    it('should throw error on Redis failure', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisError(500, 'Internal Server Error'));

      await expect(canConsumeImages('user123', 1)).rejects.toThrow('Upstash 500: Internal Server Error');
    });
  });

  describe('consumeImages', () => {
    it('should not call Redis when count is 0', async () => {
      await consumeImages('user123', 0);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should not call Redis when count is negative', async () => {
      await consumeImages('user123', -5);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should increment quota by count', async () => {
      mockFetch
        .mockResolvedValueOnce(mockRedisResponse('OK'))  // INCRBY
        .mockResolvedValueOnce(mockRedisResponse(1));     // EXPIRE

      await consumeImages('user123', 5);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('INCRBY'),
        expect.any(Object)
      );
      // The count is passed as a separate path segment
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('/5'),
        expect.any(Object)
      );
    });

    it('should set expiration to 24 hours', async () => {
      mockFetch
        .mockResolvedValueOnce(mockRedisResponse('OK'))
        .mockResolvedValueOnce(mockRedisResponse(1));

      await consumeImages('user123', 1);

      const expectedSeconds = String(60 * 60 * 24);
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('EXPIRE'),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining(encodeURIComponent(expectedSeconds)),
        expect.any(Object)
      );
    });

    it('should use correct day-based key', async () => {
      const RealDate = Date;
      const mockDate = new RealDate('2025-12-15T10:30:00Z');
      global.Date = class extends RealDate {
        constructor() {
          super();
          return mockDate;
        }
      } as any;

      mockFetch
        .mockResolvedValueOnce(mockRedisResponse('OK'))
        .mockResolvedValueOnce(mockRedisResponse(1));

      await consumeImages('user123', 1);

      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('quota%3Auser123%3A2025-12-15'),
        expect.any(Object)
      );

      global.Date = RealDate;
    });

    it('should handle Redis INCRBY failure', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisError(500, 'INCRBY failed'));

      await expect(consumeImages('user123', 5)).rejects.toThrow('Upstash 500: INCRBY failed');
    });

    it('should handle Redis EXPIRE failure', async () => {
      mockFetch
        .mockResolvedValueOnce(mockRedisResponse('OK'))
        .mockResolvedValueOnce(mockRedisError(500, 'EXPIRE failed'));

      await expect(consumeImages('user123', 5)).rejects.toThrow('Upstash 500: EXPIRE failed');
    });
  });

  describe('canStartJob', () => {
    it('should return true when under max running jobs', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(1));

      const result = await canStartJob('user123');

      expect(result).toBe(true);
    });

    it('should return true when exactly at max running jobs minus one', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(1));

      const result = await canStartJob('user123');

      expect(result).toBe(true);
    });

    it('should return false when at max running jobs', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(2));

      const result = await canStartJob('user123');

      expect(result).toBe(false);
    });

    it('should return false when over max running jobs', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(3));

      const result = await canStartJob('user123');

      expect(result).toBe(false);
    });

    it('should return true when no existing running jobs (null)', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(null));

      const result = await canStartJob('user123');

      expect(result).toBe(true);
    });

    it('should return true when no existing running jobs (undefined)', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(undefined));

      const result = await canStartJob('user123');

      expect(result).toBe(true);
    });

    it('should use correct jobsrun key format', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(0));

      await canStartJob('user123');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('jobsrun%3Auser123'),
        expect.any(Object)
      );
    });

    it('should handle Redis failure', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisError(500, 'GET failed'));

      await expect(canStartJob('user123')).rejects.toThrow('Upstash 500: GET failed');
    });
  });

  describe('incRunning', () => {
    it('should increment running job count', async () => {
      mockFetch
        .mockResolvedValueOnce(mockRedisResponse(1))   // INCR
        .mockResolvedValueOnce(mockRedisResponse(1));  // EXPIRE

      await incRunning('user123');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('INCR'),
        expect.any(Object)
      );
    });

    it('should set expiration to 2 hours', async () => {
      mockFetch
        .mockResolvedValueOnce(mockRedisResponse(1))
        .mockResolvedValueOnce(mockRedisResponse(1));

      await incRunning('user123');

      const expectedSeconds = String(60 * 60 * 2);
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('EXPIRE'),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining(encodeURIComponent(expectedSeconds)),
        expect.any(Object)
      );
    });

    it('should use correct jobsrun key', async () => {
      mockFetch
        .mockResolvedValueOnce(mockRedisResponse(1))
        .mockResolvedValueOnce(mockRedisResponse(1));

      await incRunning('user123');

      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('jobsrun%3Auser123'),
        expect.any(Object)
      );
    });

    it('should handle Redis INCR failure', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisError(500, 'INCR failed'));

      await expect(incRunning('user123')).rejects.toThrow('Upstash 500: INCR failed');
    });

    it('should handle Redis EXPIRE failure', async () => {
      mockFetch
        .mockResolvedValueOnce(mockRedisResponse(1))
        .mockResolvedValueOnce(mockRedisError(500, 'EXPIRE failed'));

      await expect(incRunning('user123')).rejects.toThrow('Upstash 500: EXPIRE failed');
    });
  });

  describe('decRunning', () => {
    it('should decrement running job count', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(0));

      await decRunning('user123');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('DECR'),
        expect.any(Object)
      );
    });

    it('should use correct jobsrun key', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(0));

      await decRunning('user123');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('jobsrun%3Auser123'),
        expect.any(Object)
      );
    });

    it('should catch and log Redis failures without throwing', async () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
      mockFetch.mockResolvedValueOnce(mockRedisError(500, 'DECR failed'));

      await decRunning('user123');

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Failed to decrement running quota',
        expect.any(Error)
      );

      consoleWarnSpy.mockRestore();
    });

    it('should not throw on network errors', async () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(decRunning('user123')).resolves.not.toThrow();

      expect(consoleWarnSpy).toHaveBeenCalled();
      consoleWarnSpy.mockRestore();
    });
  });

  describe('URL Encoding', () => {
    it('should properly encode special characters in user ID', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(0));

      await canStartJob('user@example.com');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('jobsrun%3Auser%40example.com'),
        expect.any(Object)
      );
    });

    it('should properly encode Redis commands', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(0));

      await canConsumeImages('user123', 1);

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('/GET/');
    });
  });

  describe('Quota limits', () => {
    it('should respect configured USER_FREE_IMAGES_PER_DAY (20)', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(15));

      const result = await canConsumeImages('user123', 10);

      expect(result).toBe(false); // 15 + 10 = 25, over 20 limit
    });

    it('should allow consumption up to the limit', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(15));

      const result = await canConsumeImages('user123', 5);

      expect(result).toBe(true); // 15 + 5 = 20, exactly at limit
    });

    it('should respect configured USER_MAX_RUNNING_JOBS (2)', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(1));

      const result = await canStartJob('user123');

      expect(result).toBe(true); // 1 < 2
    });

    it('should prevent starting job when at max running jobs', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(2));

      const result = await canStartJob('user123');

      expect(result).toBe(false); // 2 >= 2
    });
  });

  describe('Edge cases', () => {
    it('should handle very large counts', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(0));

      const result = await canConsumeImages('user123', 1000000);

      expect(result).toBe(false);
    });

    it('should handle userId with slashes', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(0));

      await canStartJob('user/123/test');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('user%2F123%2Ftest'),
        expect.any(Object)
      );
    });

    it('should handle empty userId', async () => {
      mockFetch.mockResolvedValueOnce(mockRedisResponse(0));

      await canStartJob('');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('jobsrun%3A'),
        expect.any(Object)
      );
    });

    it('should handle response with no result field', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '{}'
      } as any);

      const result = await canConsumeImages('user123', 1);

      expect(result).toBe(true); // undefined result treated as 0
    });
  });
});
