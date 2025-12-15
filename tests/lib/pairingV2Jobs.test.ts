/**
 * Tests for pairingV2Jobs.ts
 * Background job management for pairing-v2
 */

// Set up env vars before imports
process.env.UPSTASH_REDIS_REST_URL = 'https://test-redis.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token-12345';
process.env.APP_URL = 'https://test-app.com';

import { schedulePairingV2Job, getPairingV2JobStatus } from '../../src/lib/pairingV2Jobs.js';

// Mock global fetch
global.fetch = jest.fn();

describe('pairingV2Jobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockReset();
  });

  describe('schedulePairingV2Job - Dropbox upload', () => {
    it('should create a Dropbox job with pending status', async () => {
      // Mock Redis SETEX call
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 'OK' }),
        } as any)
        // Mock processor trigger call (fire-and-forget)
        .mockResolvedValueOnce({
          ok: true,
        } as any);

      const jobId = await schedulePairingV2Job(
        'user-123',
        'MyFolder',
        ['/path/to/image1.jpg', '/path/to/image2.jpg'],
        'dropbox-token-abc'
      );

      expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      
      // Check Redis SETEX call
      const redisCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(redisCall[0]).toContain('https://test-redis.upstash.io/setex/');
      expect(redisCall[0]).toContain('pairing-v2-job%3A'); // URL-encoded colon
      expect(redisCall[0]).toContain('/3600/'); // TTL
      
      // Check stored job data
      const encodedJob = decodeURIComponent(redisCall[0].split('/3600/')[1]);
      const storedJob = JSON.parse(encodedJob);
      
      expect(storedJob.jobId).toBe(jobId);
      expect(storedJob.userId).toBe('user-123');
      expect(storedJob.folder).toBe('MyFolder');
      expect(storedJob.status).toBe('pending');
      expect(storedJob.uploadMethod).toBe('dropbox');
      expect(storedJob.dropboxPaths).toEqual(['/path/to/image1.jpg', '/path/to/image2.jpg']);
      expect(storedJob.accessToken).toBe('dropbox-token-abc');
      expect(storedJob.processedCount).toBe(0);
      expect(storedJob.classifications).toEqual([]);
      expect(storedJob.createdAt).toBeGreaterThan(0);
      expect(storedJob.updatedAt).toBeGreaterThan(0);
    });

    it('should trigger background processor', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
        .mockResolvedValueOnce({ ok: true } as any);

      const jobId = await schedulePairingV2Job(
        'user-123',
        'MyFolder',
        ['/image.jpg'],
        'dropbox-token'
      );

      // Check processor trigger call
      const processorCall = (global.fetch as jest.Mock).mock.calls[1];
      expect(processorCall[0]).toContain('https://test-app.com/.netlify/functions/pairing-v2-processor-background');
      expect(processorCall[0]).toContain(`jobId=${jobId}`);
      expect(processorCall[1]).toEqual({ method: 'POST' });
    });

    it('should handle processor trigger failure gracefully', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
        .mockRejectedValueOnce(new Error('Network error'));

      // Should not throw even if processor trigger fails
      const jobId = await schedulePairingV2Job(
        'user-123',
        'MyFolder',
        ['/image.jpg'],
        'dropbox-token'
      );

      expect(jobId).toBeTruthy();
    });
  });

  describe('schedulePairingV2Job - Local upload', () => {
    it('should create a local job without access token', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
        .mockResolvedValueOnce({ ok: true } as any);

      const jobId = await schedulePairingV2Job(
        'user-456',
        'LocalFolder',
        ['https://staged.com/img1.jpg', 'https://staged.com/img2.jpg']
        // No accessToken = local upload
      );

      const redisCall = (global.fetch as jest.Mock).mock.calls[0];
      const encodedJob = decodeURIComponent(redisCall[0].split('/3600/')[1]);
      const storedJob = JSON.parse(encodedJob);
      
      expect(storedJob.uploadMethod).toBe('local');
      expect(storedJob.stagedUrls).toEqual(['https://staged.com/img1.jpg', 'https://staged.com/img2.jpg']);
      expect(storedJob.dropboxPaths).toBeUndefined();
      expect(storedJob.accessToken).toBeUndefined();
    });

    it('should handle empty image paths', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
        .mockResolvedValueOnce({ ok: true } as any);

      const jobId = await schedulePairingV2Job(
        'user-789',
        'EmptyFolder',
        []
      );

      const redisCall = (global.fetch as jest.Mock).mock.calls[0];
      const encodedJob = decodeURIComponent(redisCall[0].split('/3600/')[1]);
      const storedJob = JSON.parse(encodedJob);
      
      expect(storedJob.stagedUrls).toEqual([]);
    });
  });

  describe('schedulePairingV2Job - Error handling', () => {
    it('should throw if UPSTASH_REDIS_REST_URL is missing', async () => {
      const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_URL;

      await expect(
        schedulePairingV2Job('user-123', 'folder', ['/img.jpg'], 'token')
      ).rejects.toThrow('UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not configured');

      process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    });

    it('should throw if UPSTASH_REDIS_REST_TOKEN is missing', async () => {
      const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;

      await expect(
        schedulePairingV2Job('user-123', 'folder', ['/img.jpg'], 'token')
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
        schedulePairingV2Job('user-123', 'folder', ['/img.jpg'], 'token')
      ).rejects.toThrow('Redis SETEX failed: 500 Internal Server Error');
    });

    it('should include Authorization header in Redis call', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
        .mockResolvedValueOnce({ ok: true } as any);

      await schedulePairingV2Job('user-123', 'folder', ['/img.jpg'], 'token');

      const redisCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(redisCall[1]).toEqual({
        headers: { Authorization: 'Bearer test-token-12345' }
      });
    });
  });

  describe('getPairingV2JobStatus', () => {
    it('should retrieve job from Redis', async () => {
      const mockJob = {
        jobId: 'job-123',
        userId: 'user-456',
        status: 'completed',
        folder: 'TestFolder',
        uploadMethod: 'dropbox',
        dropboxPaths: ['/img.jpg'],
        accessToken: 'token',
        processedCount: 5,
        classifications: [{ url: '/img.jpg', category: 'Electronics' }],
        result: { success: true },
        createdAt: 1234567890,
        updatedAt: 1234567900,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(mockJob) }),
      } as any);

      const job = await getPairingV2JobStatus('job-123');

      expect(job).toEqual(mockJob);
      
      // Check Redis GET call
      const redisCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(redisCall[0]).toContain('https://test-redis.upstash.io/get/');
      expect(redisCall[0]).toContain('pairing-v2-job%3Ajob-123');
      expect(redisCall[1]).toEqual({
        headers: { Authorization: 'Bearer test-token-12345' }
      });
    });

    it('should return null if job not found', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      } as any);

      const job = await getPairingV2JobStatus('nonexistent-job');

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
              folder: 'Folder',
              uploadMethod: 'local',
              processedCount: 0,
              classifications: [],
              createdAt: Date.now(),
              updatedAt: Date.now(),
            })
          }),
        } as any);

        const job = await getPairingV2JobStatus('job-123');
        expect(job?.status).toBe(status);
      }
    });

    it('should handle job with error field', async () => {
      const mockJob = {
        jobId: 'job-123',
        userId: 'user-456',
        status: 'failed',
        folder: 'ErrorFolder',
        uploadMethod: 'local',
        processedCount: 0,
        classifications: [],
        error: 'Processing failed: timeout',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(mockJob) }),
      } as any);

      const job = await getPairingV2JobStatus('job-123');

      expect(job?.status).toBe('failed');
      expect(job?.error).toBe('Processing failed: timeout');
    });

    it('should throw if UPSTASH_REDIS_REST_URL is missing', async () => {
      const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_URL;

      await expect(
        getPairingV2JobStatus('job-123')
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
        getPairingV2JobStatus('job-123')
      ).rejects.toThrow('Redis GET failed: 401 Unauthorized');
    });

    it('should handle job with result field', async () => {
      const mockJob = {
        jobId: 'job-123',
        userId: 'user-456',
        status: 'completed',
        folder: 'SuccessFolder',
        uploadMethod: 'dropbox',
        dropboxPaths: ['/img.jpg'],
        processedCount: 10,
        classifications: [],
        result: {
          products: [{ title: 'Product 1', imageIndex: 0 }],
          unmatchedImages: [],
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(mockJob) }),
      } as any);

      const job = await getPairingV2JobStatus('job-123');

      expect(job?.result).toBeDefined();
      expect((job?.result as any)?.products).toHaveLength(1);
      expect((job?.result as any)?.unmatchedImages).toEqual([]);
    });

    it('should handle chunked processing state fields', async () => {
      const mockJob = {
        jobId: 'job-123',
        userId: 'user-456',
        status: 'processing',
        folder: 'ChunkedFolder',
        uploadMethod: 'local',
        stagedUrls: ['url1', 'url2', 'url3'],
        processedCount: 2,
        classifications: [
          { url: 'url1', category: 'Cat1' },
          { url: 'url2', category: 'Cat2' }
        ],
        lastChunkTriggered: 1234567890,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(mockJob) }),
      } as any);

      const job = await getPairingV2JobStatus('job-123');

      expect(job?.processedCount).toBe(2);
      expect(job?.classifications).toHaveLength(2);
      expect(job?.lastChunkTriggered).toBe(1234567890);
    });
  });

  describe('Job data structure', () => {
    it('should create job with all required fields', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
        .mockResolvedValueOnce({ ok: true } as any);

      const jobId = await schedulePairingV2Job(
        'user-123',
        'MyFolder',
        ['/image1.jpg', '/image2.jpg'],
        'token'
      );

      const redisCall = (global.fetch as jest.Mock).mock.calls[0];
      const encodedJob = decodeURIComponent(redisCall[0].split('/3600/')[1]);
      const job = JSON.parse(encodedJob);

      // Verify all required fields are present
      expect(job).toHaveProperty('jobId');
      expect(job).toHaveProperty('userId');
      expect(job).toHaveProperty('status');
      expect(job).toHaveProperty('folder');
      expect(job).toHaveProperty('uploadMethod');
      expect(job).toHaveProperty('processedCount');
      expect(job).toHaveProperty('classifications');
      expect(job).toHaveProperty('createdAt');
      expect(job).toHaveProperty('updatedAt');
    });

    it('should use correct TTL for Redis storage', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
        .mockResolvedValueOnce({ ok: true } as any);

      await schedulePairingV2Job('user-123', 'folder', ['/img.jpg']);

      const redisCall = (global.fetch as jest.Mock).mock.calls[0];
      // TTL should be 3600 seconds (1 hour)
      expect(redisCall[0]).toContain('/3600/');
    });

    it('should generate unique job IDs', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValue({ ok: true, json: async () => ({ result: 'OK' }) } as any);

      const jobId1 = await schedulePairingV2Job('user-1', 'folder', ['/img1.jpg']);
      const jobId2 = await schedulePairingV2Job('user-2', 'folder', ['/img2.jpg']);
      const jobId3 = await schedulePairingV2Job('user-3', 'folder', ['/img3.jpg']);

      expect(jobId1).not.toBe(jobId2);
      expect(jobId2).not.toBe(jobId3);
      expect(jobId1).not.toBe(jobId3);
    });
  });
});
