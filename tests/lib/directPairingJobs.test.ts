/**
 * Tests for directPairingJobs.ts
 * Background job management for direct pairing
 */

// Set up env vars before imports
process.env.UPSTASH_REDIS_REST_URL = 'https://test-redis.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token-12345';

import { scheduleDirectPairingJob, getDirectPairingJobStatus } from '../../src/lib/directPairingJobs.js';

// Mock global fetch
global.fetch = jest.fn();

// Mock directPairing module
jest.mock('../../src/lib/directPairing.js', () => ({
  directPairProductsFromImages: jest.fn()
}));

import { directPairProductsFromImages } from '../../src/lib/directPairing.js';

describe('directPairingJobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockReset();
    (directPairProductsFromImages as jest.Mock).mockReset();
  });

  describe('scheduleDirectPairingJob', () => {
    it('should create a job with pending status', async () => {
      // Mock Redis SETEX call
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      } as any);

      const images = [
        { url: 'https://example.com/img1.jpg', filename: 'img1.jpg', folder: 'Product1' },
        { url: 'https://example.com/img2.jpg', filename: 'img2.jpg', folder: 'Product2' }
      ];

      const jobId = await scheduleDirectPairingJob('user-123', images);

      expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      
      // Check Redis SETEX call
      const redisCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(redisCall[0]).toContain('https://test-redis.upstash.io/setex/');
      expect(redisCall[0]).toContain('direct-pairing-job%3A'); // URL-encoded colon
      expect(redisCall[0]).toContain('/3600/'); // TTL
      
      // Check stored job data
      const encodedJob = decodeURIComponent(redisCall[0].split('/3600/')[1]);
      const storedJob = JSON.parse(encodedJob);
      
      expect(storedJob.jobId).toBe(jobId);
      expect(storedJob.userId).toBe('user-123');
      expect(storedJob.status).toBe('pending');
      expect(storedJob.images).toEqual(images);
      expect(storedJob.createdAt).toBeGreaterThan(0);
      expect(storedJob.updatedAt).toBeGreaterThan(0);
    });

    it('should handle empty images array', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      } as any);

      const jobId = await scheduleDirectPairingJob('user-456', []);

      expect(jobId).toBeTruthy();
      
      const redisCall = (global.fetch as jest.Mock).mock.calls[0];
      const encodedJob = decodeURIComponent(redisCall[0].split('/3600/')[1]);
      const storedJob = JSON.parse(encodedJob);
      
      expect(storedJob.images).toEqual([]);
    });

    it('should trigger background processing', async () => {
      const images = [{ url: 'https://example.com/img.jpg', filename: 'img.jpg', folder: 'Test' }];
      
      (global.fetch as jest.Mock)
        // SETEX for job creation
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 'OK' }),
        } as any)
        // GET for background processing - return the job we just created
        .mockImplementationOnce(async (url) => {
          // Extract job data from the first SETEX call
          const firstCall = (global.fetch as jest.Mock).mock.calls[0][0];
          const encodedJob = decodeURIComponent(firstCall.split('/3600/')[1]);
          return {
            ok: true,
            json: async () => ({ result: encodedJob }),
          };
        })
        // SETEX for status update to processing
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 'OK' }),
        } as any)
        // SETEX for completion
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 'OK' }),
        } as any);

      (directPairProductsFromImages as jest.Mock).mockResolvedValueOnce({
        products: [{ title: 'Product 1', images: ['img1.jpg'] }],
        unmatchedImages: []
      });

      const jobId = await scheduleDirectPairingJob('user-789', images);

      expect(jobId).toBeTruthy();

      // Wait a bit for background processing to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should have called directPairProductsFromImages
      expect(directPairProductsFromImages).toHaveBeenCalledWith(images);
    });

    it('should throw if UPSTASH_REDIS_REST_URL is missing', async () => {
      const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_URL;

      await expect(
        scheduleDirectPairingJob('user-123', [])
      ).rejects.toThrow('UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not configured');

      process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    });

    it('should throw if UPSTASH_REDIS_REST_TOKEN is missing', async () => {
      const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;

      await expect(
        scheduleDirectPairingJob('user-123', [])
      ).rejects.toThrow('UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not configured');

      process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    });

    it('should throw if Redis SETEX fails', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      } as any);

      await expect(
        scheduleDirectPairingJob('user-123', [])
      ).rejects.toThrow('Redis SETEX failed: 500 Internal Server Error');
    });

    it('should include Authorization header in Redis call', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      } as any);

      await scheduleDirectPairingJob('user-123', []);

      const redisCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(redisCall[1]).toEqual({
        headers: { Authorization: 'Bearer test-token-12345' }
      });
    });

    it('should generate unique job IDs', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ result: 'OK' }),
      } as any);

      const jobId1 = await scheduleDirectPairingJob('user-1', []);
      const jobId2 = await scheduleDirectPairingJob('user-2', []);
      const jobId3 = await scheduleDirectPairingJob('user-3', []);

      expect(jobId1).not.toBe(jobId2);
      expect(jobId2).not.toBe(jobId3);
      expect(jobId1).not.toBe(jobId3);
    });
  });

  describe('getDirectPairingJobStatus', () => {
    it('should retrieve job from Redis', async () => {
      const mockJob = {
        jobId: 'job-123',
        userId: 'user-456',
        status: 'completed',
        images: [{ url: 'https://example.com/img.jpg', filename: 'img.jpg', folder: 'Test' }],
        result: {
          products: [{ title: 'Product 1', images: ['img.jpg'] }],
          unmatchedImages: []
        },
        createdAt: 1234567890,
        updatedAt: 1234567900,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(mockJob) }),
      } as any);

      const job = await getDirectPairingJobStatus('job-123');

      expect(job).toEqual(mockJob);
      
      // Check Redis GET call
      const redisCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(redisCall[0]).toContain('https://test-redis.upstash.io/get/');
      expect(redisCall[0]).toContain('direct-pairing-job%3Ajob-123');
      expect(redisCall[1]).toEqual({
        headers: { Authorization: 'Bearer test-token-12345' }
      });
    });

    it('should return null if job not found', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      } as any);

      const job = await getDirectPairingJobStatus('nonexistent-job');

      expect(job).toBeNull();
    });

    it('should handle different job statuses', async () => {
      const statuses = ['pending', 'processing', 'completed', 'failed'];

      for (const status of statuses) {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              jobId: 'job-123',
              userId: 'user-456',
              status,
              images: [],
              createdAt: Date.now(),
              updatedAt: Date.now(),
            })
          }),
        } as any);

        const job = await getDirectPairingJobStatus('job-123');
        expect(job?.status).toBe(status);
      }
    });

    it('should handle job with error field', async () => {
      const mockJob = {
        jobId: 'job-123',
        userId: 'user-456',
        status: 'failed',
        images: [],
        error: 'Processing failed: timeout',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(mockJob) }),
      } as any);

      const job = await getDirectPairingJobStatus('job-123');

      expect(job?.status).toBe('failed');
      expect(job?.error).toBe('Processing failed: timeout');
    });

    it('should throw if UPSTASH_REDIS_REST_URL is missing', async () => {
      const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_URL;

      await expect(
        getDirectPairingJobStatus('job-123')
      ).rejects.toThrow('UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not configured');

      process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    });

    it('should throw if Redis GET fails', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      } as any);

      await expect(
        getDirectPairingJobStatus('job-123')
      ).rejects.toThrow('Redis GET failed: 401 Unauthorized');
    });

    it('should handle job with result field', async () => {
      const mockJob = {
        jobId: 'job-123',
        userId: 'user-456',
        status: 'completed',
        images: [{ url: 'https://example.com/img.jpg', filename: 'img.jpg', folder: 'Product' }],
        result: {
          products: [
            { title: 'Product 1', images: ['img1.jpg', 'img2.jpg'] },
            { title: 'Product 2', images: ['img3.jpg'] }
          ],
          unmatchedImages: ['unmatched.jpg']
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(mockJob) }),
      } as any);

      const job = await getDirectPairingJobStatus('job-123');

      expect(job?.result).toBeDefined();
      expect(job?.result?.products).toHaveLength(2);
      expect(job?.result?.unmatchedImages).toEqual(['unmatched.jpg']);
    });
  });

  describe('Job data structure', () => {
    it('should create job with all required fields', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      } as any);

      const images = [
        { url: 'https://example.com/img1.jpg', filename: 'img1.jpg', folder: 'Product1' },
        { url: 'https://example.com/img2.jpg', filename: 'img2.jpg', folder: 'Product2' }
      ];

      await scheduleDirectPairingJob('user-123', images);

      const redisCall = (global.fetch as jest.Mock).mock.calls[0];
      const encodedJob = decodeURIComponent(redisCall[0].split('/3600/')[1]);
      const job = JSON.parse(encodedJob);

      // Verify all required fields are present
      expect(job).toHaveProperty('jobId');
      expect(job).toHaveProperty('userId');
      expect(job).toHaveProperty('status');
      expect(job).toHaveProperty('images');
      expect(job).toHaveProperty('createdAt');
      expect(job).toHaveProperty('updatedAt');
    });

    it('should use correct TTL for Redis storage', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      } as any);

      await scheduleDirectPairingJob('user-123', []);

      const redisCall = (global.fetch as jest.Mock).mock.calls[0];
      // TTL should be 3600 seconds (1 hour)
      expect(redisCall[0]).toContain('/3600/');
    });

    it('should preserve image data structure', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      } as any);

      const images = [
        { url: 'https://example.com/img1.jpg', filename: 'img1.jpg', folder: 'Product A' },
        { url: 'https://example.com/img2.jpg', filename: 'img2.jpg', folder: 'Product B' }
      ];

      await scheduleDirectPairingJob('user-789', images);

      const redisCall = (global.fetch as jest.Mock).mock.calls[0];
      const encodedJob = decodeURIComponent(redisCall[0].split('/3600/')[1]);
      const job = JSON.parse(encodedJob);

      expect(job.images).toEqual(images);
      expect(job.images[0].url).toBe('https://example.com/img1.jpg');
      expect(job.images[0].folder).toBe('Product A');
    });
  });

  describe('Background processing', () => {
    it('should handle background processing errors gracefully', async () => {
      (global.fetch as jest.Mock)
        // SETEX for job creation
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 'OK' }),
        } as any)
        // GET for background processing
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              jobId: 'job-error',
              userId: 'user-error',
              status: 'pending',
              images: [{ url: 'https://example.com/img.jpg', filename: 'img.jpg', folder: 'Test' }],
              createdAt: Date.now(),
              updatedAt: Date.now()
            })
          }),
        } as any)
        // SETEX for status update to processing
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 'OK' }),
        } as any)
        // GET for error handling
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              jobId: 'job-error',
              userId: 'user-error',
              status: 'processing',
              images: [],
              createdAt: Date.now(),
              updatedAt: Date.now()
            })
          }),
        } as any)
        // SETEX for error state update
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 'OK' }),
        } as any);

      (directPairProductsFromImages as jest.Mock).mockRejectedValueOnce(
        new Error('Pairing failed')
      );

      const images = [{ url: 'https://example.com/img.jpg', filename: 'img.jpg', folder: 'Test' }];
      const jobId = await scheduleDirectPairingJob('user-error', images);

      expect(jobId).toBeTruthy();

      // Wait for background processing to handle error
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should have attempted to call directPairProductsFromImages
      expect(directPairProductsFromImages).toHaveBeenCalled();
    });

    it('should not throw if background processing fails', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      } as any);

      // Don't set up further mocks - background will fail
      
      const images = [{ url: 'https://example.com/img.jpg', filename: 'img.jpg', folder: 'Test' }];
      
      // Should not throw even though background processing will fail
      await expect(
        scheduleDirectPairingJob('user-123', images)
      ).resolves.toBeTruthy();
    });
  });
});
