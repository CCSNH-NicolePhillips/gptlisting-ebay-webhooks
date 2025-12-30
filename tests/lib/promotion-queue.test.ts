/**
 * Tests for promotion queue system
 */

// Set up Redis env vars BEFORE importing the module
process.env.UPSTASH_REDIS_REST_URL = 'https://test-redis.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

// Mock fetch globally
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

import {
  queuePromotionJob,
  queuePromotionBatch,
  getReadyJobs,
  updateJob,
  getJobStatus,
  getQueueStats,
  cancelJob,
  storePromotionIntent,
  getPromotionIntent,
  deletePromotionIntent,
} from '../../src/lib/promotion-queue';

describe('promotion-queue', () => {
  const mockRedisResponse = (result: any) => Promise.resolve({
    ok: true,
    json: async () => ({ result }),
  } as Response);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('queuePromotionJob', () => {
    it('should queue a single promotion job', async () => {
      (global.fetch as jest.Mock)
        .mockImplementationOnce(() => mockRedisResponse('OK')) // SET job data
        .mockImplementationOnce(() => mockRedisResponse(1)); // ZADD to queue

      const jobId = await queuePromotionJob('user123', '177681098666', 5);

      expect(jobId).toContain('177681098666_');
      expect(global.fetch).toHaveBeenCalledTimes(2);
      
      // Verify SET call
      expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('/SET/');
      expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('promo_job%3A'); // URL encoded
      
      // Verify ZADD call
      expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('/ZADD/');
      expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('promotion_queue');
    });

    it('should include campaign ID when provided', async () => {
      (global.fetch as jest.Mock)
        .mockImplementationOnce(() => mockRedisResponse('OK'))
        .mockImplementationOnce(() => mockRedisResponse(1));

      await queuePromotionJob('user123', '177681098666', 5, {
        campaignId: 'campaign-123',
      });

      const setCall = (global.fetch as jest.Mock).mock.calls[0][0];
      expect(setCall).toContain('campaign-123');
    });

    it('should include sku when provided', async () => {
      (global.fetch as jest.Mock)
        .mockImplementationOnce(() => mockRedisResponse('OK'))
        .mockImplementationOnce(() => mockRedisResponse(1));

      await queuePromotionJob('user123', '177681098666', 5, {
        sku: 'SKU-123',
      });

      const setCall = (global.fetch as jest.Mock).mock.calls[0][0];
      const jobData = decodeURIComponent(setCall.split('/SET/')[1].split('/')[1]);
      expect(jobData).toContain('"sku":"SKU-123"');
    });

    it('should use custom maxAttempts when provided', async () => {
      (global.fetch as jest.Mock)
        .mockImplementationOnce(() => mockRedisResponse('OK'))
        .mockImplementationOnce(() => mockRedisResponse(1));

      await queuePromotionJob('user123', '177681098666', 5, {
        maxAttempts: 3,
      });

      const setCall = (global.fetch as jest.Mock).mock.calls[0][0];
      const jobData = decodeURIComponent(setCall.split('/SET/')[1].split('/')[1]);
      expect(jobData).toContain('"maxAttempts":3');
    });

    it('should handle Redis errors', async () => {
      (global.fetch as jest.Mock).mockImplementationOnce(() => Promise.resolve({
        ok: false,
        status: 500,
        text: async () => 'Redis error',
      } as Response));

      await expect(
        queuePromotionJob('user123', '177681098666', 5)
      ).rejects.toThrow('Redis SET failed 500');
    });
  });

  describe('queuePromotionBatch', () => {
    it('should queue multiple jobs with staggered retry times', async () => {
      // Mock SET and ZADD for each job
      (global.fetch as jest.Mock)
        .mockImplementation(() => mockRedisResponse('OK'));

      const jobs = [
        { userId: 'user123', listingId: '111', adRate: 5 },
        { userId: 'user123', listingId: '222', adRate: 7 },
        { userId: 'user123', listingId: '333', adRate: 5 },
      ];

      const jobIds = await queuePromotionBatch(jobs);

      expect(jobIds).toHaveLength(3);
      expect(jobIds[0]).toContain('111_');
      expect(jobIds[1]).toContain('222_');
      expect(jobIds[2]).toContain('333_');
      
      // Should have 2 calls per job (SET + ZADD)
      expect(global.fetch).toHaveBeenCalledTimes(6);
    });

    it('should include campaign IDs when provided', async () => {
      (global.fetch as jest.Mock).mockImplementation(() => mockRedisResponse('OK'));

      const jobs = [
        { userId: 'user123', listingId: '111', adRate: 5, campaignId: 'camp1' },
        { userId: 'user123', listingId: '222', adRate: 7, campaignId: 'camp2' },
      ];

      await queuePromotionBatch(jobs);

      const calls = (global.fetch as jest.Mock).mock.calls.map(c => c[0]);
      const setCalls = calls.filter((c: string) => c.includes('/SET/'));
      
      expect(setCalls[0]).toContain('camp1');
      expect(setCalls[1]).toContain('camp2');
    });

    it('should include sku values when present in batch', async () => {
      (global.fetch as jest.Mock).mockImplementation(() => mockRedisResponse('OK'));

      const jobs = [
        { userId: 'user123', listingId: '111', adRate: 5, sku: 'SKU-1' },
        { userId: 'user123', listingId: '222', adRate: 7, sku: 'SKU-2' },
      ];

      await queuePromotionBatch(jobs);

      const calls = (global.fetch as jest.Mock).mock.calls
        .map(c => c[0])
        .filter((c: string) => c.includes('/SET/'));

      const jobPayloads = calls.map((url) => decodeURIComponent(url.split('/SET/')[1].split('/')[1]));
      expect(jobPayloads[0]).toContain('"sku":"SKU-1"');
      expect(jobPayloads[1]).toContain('"sku":"SKU-2"');
    });

    it('should handle empty batch', async () => {
      const jobIds = await queuePromotionBatch([]);
      expect(jobIds).toHaveLength(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('getReadyJobs', () => {
    it('should fetch jobs ready to process', async () => {
      const mockJob1 = JSON.stringify({
        id: 'job1',
        userId: 'user123',
        listingId: '111',
        adRate: 5,
        attempts: 0,
        maxAttempts: 5,
        nextRetryAt: Date.now() - 1000,
        createdAt: Date.now() - 60000,
      });

      const mockJob2 = JSON.stringify({
        id: 'job2',
        userId: 'user123',
        listingId: '222',
        adRate: 7,
        attempts: 1,
        maxAttempts: 5,
        nextRetryAt: Date.now() - 500,
        createdAt: Date.now() - 120000,
      });

      (global.fetch as jest.Mock)
        .mockImplementationOnce(() => mockRedisResponse(['job1', 'job2'])) // ZRANGEBYSCORE
        .mockImplementationOnce(() => mockRedisResponse(mockJob1)) // GET job1
        .mockImplementationOnce(() => mockRedisResponse(mockJob2)); // GET job2

      const jobs = await getReadyJobs(10);

      expect(jobs).toHaveLength(2);
      expect(jobs[0].id).toBe('job1');
      expect(jobs[0].listingId).toBe('111');
      expect(jobs[1].id).toBe('job2');
      expect(jobs[1].attempts).toBe(1);
    });

    it('should return empty array when no jobs ready', async () => {
      (global.fetch as jest.Mock).mockImplementationOnce(() => mockRedisResponse([]));

      const jobs = await getReadyJobs(10);

      expect(jobs).toHaveLength(0);
    });

    it('should respect limit parameter', async () => {
      (global.fetch as jest.Mock).mockImplementationOnce(() => mockRedisResponse([]));

      await getReadyJobs(5);

      const zrangeCall = (global.fetch as jest.Mock).mock.calls[0][0];
      expect(zrangeCall).toContain('/LIMIT/0/5');
    });
  });

  describe('updateJob', () => {
    it('should remove job on success', async () => {
      const mockJob = JSON.stringify({
        id: 'job1',
        userId: 'user123',
        listingId: '111',
        adRate: 5,
        attempts: 2,
        maxAttempts: 5,
        nextRetryAt: Date.now(),
        createdAt: Date.now() - 60000,
      });

      (global.fetch as jest.Mock)
        .mockImplementationOnce(() => mockRedisResponse(mockJob)) // GET job
        .mockImplementationOnce(() => mockRedisResponse(1)) // ZREM
        .mockImplementationOnce(() => mockRedisResponse(1)); // DEL

      await updateJob('job1', true);

      expect(global.fetch).toHaveBeenCalledTimes(3);
      
      // Verify ZREM call
      expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('/ZREM/');
      
      // Verify DEL call
      expect((global.fetch as jest.Mock).mock.calls[2][0]).toContain('/DEL/');
    });

    it('should schedule retry on failure within max attempts', async () => {
      const mockJob = JSON.stringify({
        id: 'job1',
        userId: 'user123',
        listingId: '111',
        adRate: 5,
        attempts: 1,
        maxAttempts: 5,
        nextRetryAt: Date.now(),
        createdAt: Date.now() - 60000,
      });

      (global.fetch as jest.Mock)
        .mockImplementationOnce(() => mockRedisResponse(mockJob)) // GET job
        .mockImplementationOnce(() => mockRedisResponse('OK')) // SET updated job
        .mockImplementationOnce(() => mockRedisResponse(1)); // ZADD with new score

      await updateJob('job1', false, 'Listing not synced yet');

      expect(global.fetch).toHaveBeenCalledTimes(3);
      
      // Verify job was updated with new attempt count
      const setCall = (global.fetch as jest.Mock).mock.calls[1][0];
      const updatedJobData = decodeURIComponent(setCall.split('/SET/')[1].split('/')[1]);
      expect(updatedJobData).toContain('"attempts":2');
      expect(updatedJobData).toContain('Listing not synced yet');
    });

    it('should remove job after max attempts', async () => {
      const mockJob = JSON.stringify({
        id: 'job1',
        userId: 'user123',
        listingId: '111',
        adRate: 5,
        attempts: 4,
        maxAttempts: 5,
        nextRetryAt: Date.now(),
        createdAt: Date.now() - 60000,
      });

      (global.fetch as jest.Mock)
        .mockImplementationOnce(() => mockRedisResponse(mockJob)) // GET job
        .mockImplementationOnce(() => mockRedisResponse(1)) // ZREM
        .mockImplementationOnce(() => mockRedisResponse(1)); // DEL

      await updateJob('job1', false, 'Still not ready');

      // Should remove job, not retry
      expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('/ZREM/');
      expect((global.fetch as jest.Mock).mock.calls[2][0]).toContain('/DEL/');
    });

    it('should handle missing job gracefully', async () => {
      (global.fetch as jest.Mock).mockImplementationOnce(() => mockRedisResponse(null));

      await updateJob('nonexistent', true);

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('getJobStatus', () => {
    it('should return job data', async () => {
      const mockJob = JSON.stringify({
        id: 'job1',
        userId: 'user123',
        listingId: '111',
        adRate: 5,
        attempts: 2,
        maxAttempts: 5,
        nextRetryAt: Date.now(),
        createdAt: Date.now() - 60000,
      });

      (global.fetch as jest.Mock).mockImplementationOnce(() => mockRedisResponse(mockJob));

      const job = await getJobStatus('job1');

      expect(job).not.toBeNull();
      expect(job?.id).toBe('job1');
      expect(job?.listingId).toBe('111');
      expect(job?.attempts).toBe(2);
    });

    it('should return null for nonexistent job', async () => {
      (global.fetch as jest.Mock).mockImplementationOnce(() => mockRedisResponse(null));

      const job = await getJobStatus('nonexistent');

      expect(job).toBeNull();
    });
  });

  describe('getQueueStats', () => {
    it('should return queue statistics', async () => {
      (global.fetch as jest.Mock)
        .mockImplementationOnce(() => mockRedisResponse(15)) // ZCARD (total)
        .mockImplementationOnce(() => mockRedisResponse(3)); // ZCOUNT (ready)

      const stats = await getQueueStats();

      expect(stats.total).toBe(15);
      expect(stats.ready).toBe(3);
      expect(stats.pending).toBe(12);
    });

    it('should handle empty queue', async () => {
      (global.fetch as jest.Mock)
        .mockImplementationOnce(() => mockRedisResponse(0))
        .mockImplementationOnce(() => mockRedisResponse(0));

      const stats = await getQueueStats();

      expect(stats.total).toBe(0);
      expect(stats.ready).toBe(0);
      expect(stats.pending).toBe(0);
    });
  });

  describe('cancelJob', () => {
    it('should remove job from queue and delete data', async () => {
      (global.fetch as jest.Mock)
        .mockImplementationOnce(() => mockRedisResponse(1)) // ZREM
        .mockImplementationOnce(() => mockRedisResponse(1)); // DEL

      const result = await cancelJob('job1');

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should return false if job not in queue', async () => {
      (global.fetch as jest.Mock)
        .mockImplementationOnce(() => mockRedisResponse(0)) // ZREM returned 0
        .mockImplementationOnce(() => mockRedisResponse(0)); // DEL

      const result = await cancelJob('nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('exponential backoff', () => {
    it('should use correct delays for retry attempts', async () => {
      const mockJob = (attempts: number) => JSON.stringify({
        id: 'job1',
        userId: 'user123',
        listingId: '111',
        adRate: 5,
        attempts,
        maxAttempts: 5,
        nextRetryAt: Date.now(),
        createdAt: Date.now() - 60000,
      });

      // Test attempt 1 -> 2 (should be 2 minutes)
      (global.fetch as jest.Mock)
        .mockImplementationOnce(() => mockRedisResponse(mockJob(1)))
        .mockImplementationOnce(() => mockRedisResponse('OK'))
        .mockImplementationOnce(() => mockRedisResponse(1));

      await updateJob('job1', false, 'Test');

      const setCall1 = (global.fetch as jest.Mock).mock.calls[1][0];
      const jobData1 = JSON.parse(decodeURIComponent(setCall1.split('/SET/')[1].split('/')[1]));
      const delay1 = jobData1.nextRetryAt - Date.now();
      
      // Should be ~2 minutes (120000ms), allow some variance
      expect(delay1).toBeGreaterThan(115000);
      expect(delay1).toBeLessThan(125000);

      jest.clearAllMocks();

      // Test attempt 2 -> 3 (should be 4 minutes)
      (global.fetch as jest.Mock)
        .mockImplementationOnce(() => mockRedisResponse(mockJob(2)))
        .mockImplementationOnce(() => mockRedisResponse('OK'))
        .mockImplementationOnce(() => mockRedisResponse(1));

      await updateJob('job1', false, 'Test');

      const setCall2 = (global.fetch as jest.Mock).mock.calls[1][0];
      const jobData2 = JSON.parse(decodeURIComponent(setCall2.split('/SET/')[1].split('/')[1]));
      const delay2 = jobData2.nextRetryAt - Date.now();
      
      // Should be ~4 minutes (240000ms)
      expect(delay2).toBeGreaterThan(235000);
      expect(delay2).toBeLessThan(245000);
    });

    it('should cap delay at 10 minutes', async () => {
      const mockJob = JSON.stringify({
        id: 'job1',
        userId: 'user123',
        listingId: '111',
        adRate: 5,
        attempts: 4, // High attempt count
        maxAttempts: 10,
        nextRetryAt: Date.now(),
        createdAt: Date.now() - 600000,
      });

      (global.fetch as jest.Mock)
        .mockImplementationOnce(() => mockRedisResponse(mockJob))
        .mockImplementationOnce(() => mockRedisResponse('OK'))
        .mockImplementationOnce(() => mockRedisResponse(1));

      await updateJob('job1', false, 'Test');

      const setCall = (global.fetch as jest.Mock).mock.calls[1][0];
      const jobData = JSON.parse(decodeURIComponent(setCall.split('/SET/')[1].split('/')[1]));
      const delay = jobData.nextRetryAt - Date.now();
      
      // Should be capped at 10 minutes (600000ms)
      expect(delay).toBeLessThanOrEqual(600000);
    });
  });

  describe('error handling', () => {
    it('should handle Redis connection errors', async () => {
      process.env.UPSTASH_REDIS_REST_URL = '';
      process.env.UPSTASH_REDIS_REST_TOKEN = '';

      const result = await queuePromotionJob('user123', '111', 5).catch(e => e);

      expect(result).toBeDefined();
    });

    it('should handle malformed Redis responses', async () => {
      (global.fetch as jest.Mock).mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: async () => ({ result: 'not-json' }),
      } as Response));

      const jobs = await getReadyJobs(10).catch(() => []);
      
      expect(jobs).toEqual([]);
    });
  });

  // ============================================================================
  // Promotion Intent Tests - Tests the Redis-based promotion intent storage
  // that bridges offer creation and publishing
  // ============================================================================
  describe('promotion intent storage', () => {
    beforeEach(() => {
      // Ensure Redis env vars are set for these tests
      process.env.UPSTASH_REDIS_REST_URL = 'https://test-redis.upstash.io';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
      jest.clearAllMocks();
    });

    describe('storePromotionIntent', () => {
      it('should store promotion intent with correct key and TTL', async () => {
        (global.fetch as jest.Mock)
          .mockImplementationOnce(() => mockRedisResponse('OK')) // SET
          .mockImplementationOnce(() => mockRedisResponse(1)); // EXPIRE

        await storePromotionIntent('offer-123', true, 5);

        expect(global.fetch).toHaveBeenCalledTimes(2);
        
        // Verify SET call contains correct key
        const setCall = (global.fetch as jest.Mock).mock.calls[0][0];
        expect(setCall).toContain('/SET/');
        expect(setCall).toContain('promo_intent%3Aoffer-123'); // URL encoded
        
        // Verify EXPIRE call sets 7-day TTL (604800 seconds)
        const expireCall = (global.fetch as jest.Mock).mock.calls[1][0];
        expect(expireCall).toContain('/EXPIRE/');
        expect(expireCall).toContain('604800');
      });

      it('should store correct intent data structure', async () => {
        (global.fetch as jest.Mock)
          .mockImplementationOnce(() => mockRedisResponse('OK'))
          .mockImplementationOnce(() => mockRedisResponse(1));

        await storePromotionIntent('offer-456', true, 7.5);

        const setCall = (global.fetch as jest.Mock).mock.calls[0][0];
        const intentData = decodeURIComponent(setCall.split('/SET/')[1].split('/')[1]);
        const parsed = JSON.parse(intentData);
        
        expect(parsed.offerId).toBe('offer-456');
        expect(parsed.enabled).toBe(true);
        expect(parsed.adRate).toBe(7.5);
        expect(parsed.createdAt).toBeDefined();
        expect(typeof parsed.createdAt).toBe('number');
      });

      it('should store disabled intent', async () => {
        (global.fetch as jest.Mock)
          .mockImplementationOnce(() => mockRedisResponse('OK'))
          .mockImplementationOnce(() => mockRedisResponse(1));

        await storePromotionIntent('offer-789', false, 0);

        const setCall = (global.fetch as jest.Mock).mock.calls[0][0];
        const intentData = decodeURIComponent(setCall.split('/SET/')[1].split('/')[1]);
        const parsed = JSON.parse(intentData);
        
        expect(parsed.enabled).toBe(false);
        expect(parsed.adRate).toBe(0);
      });

      it('should not throw when Redis is not configured', async () => {
        process.env.UPSTASH_REDIS_REST_URL = '';
        process.env.UPSTASH_REDIS_REST_TOKEN = '';

        // Should not throw, just warn
        await expect(storePromotionIntent('offer-xyz', true, 5)).resolves.toBeUndefined();
      });
    });

    describe('getPromotionIntent', () => {
      it('should retrieve stored promotion intent', async () => {
        const storedIntent = {
          offerId: 'offer-123',
          enabled: true,
          adRate: 5,
          createdAt: Date.now(),
        };

        (global.fetch as jest.Mock).mockImplementationOnce(() => 
          mockRedisResponse(JSON.stringify(storedIntent))
        );

        const result = await getPromotionIntent('offer-123');

        expect(result).toEqual(storedIntent);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        
        const getCall = (global.fetch as jest.Mock).mock.calls[0][0];
        expect(getCall).toContain('/GET/');
        expect(getCall).toContain('promo_intent%3Aoffer-123');
      });

      it('should return null when intent not found', async () => {
        (global.fetch as jest.Mock).mockImplementationOnce(() => 
          mockRedisResponse(null)
        );

        const result = await getPromotionIntent('nonexistent-offer');

        expect(result).toBeNull();
      });

      it('should return null for malformed JSON', async () => {
        (global.fetch as jest.Mock).mockImplementationOnce(() => 
          mockRedisResponse('not-valid-json{')
        );

        const result = await getPromotionIntent('offer-bad-data');

        expect(result).toBeNull();
      });

      it('should return null when Redis is not configured', async () => {
        process.env.UPSTASH_REDIS_REST_URL = '';
        process.env.UPSTASH_REDIS_REST_TOKEN = '';

        const result = await getPromotionIntent('offer-xyz');

        expect(result).toBeNull();
      });
    });

    describe('deletePromotionIntent', () => {
      it('should delete promotion intent by offerId', async () => {
        (global.fetch as jest.Mock).mockImplementationOnce(() => 
          mockRedisResponse(1) // DEL returns count of deleted keys
        );

        await deletePromotionIntent('offer-123');

        expect(global.fetch).toHaveBeenCalledTimes(1);
        
        const delCall = (global.fetch as jest.Mock).mock.calls[0][0];
        expect(delCall).toContain('/DEL/');
        expect(delCall).toContain('promo_intent%3Aoffer-123');
      });

      it('should not throw when deleting non-existent intent', async () => {
        (global.fetch as jest.Mock).mockImplementationOnce(() => 
          mockRedisResponse(0) // DEL returns 0 when key doesn't exist
        );

        await expect(deletePromotionIntent('nonexistent')).resolves.toBeUndefined();
      });

      it('should not throw when Redis is not configured', async () => {
        process.env.UPSTASH_REDIS_REST_URL = '';
        process.env.UPSTASH_REDIS_REST_TOKEN = '';

        await expect(deletePromotionIntent('offer-xyz')).resolves.toBeUndefined();
      });
    });

    describe('promotion intent flow integration', () => {
      it('should store and retrieve intent correctly (simulated flow)', async () => {
        const offerId = 'offer-flow-test-123';
        const adRate = 7;
        
        // Simulate storing intent when offer is created
        (global.fetch as jest.Mock)
          .mockImplementationOnce(() => mockRedisResponse('OK')) // SET
          .mockImplementationOnce(() => mockRedisResponse(1)); // EXPIRE

        await storePromotionIntent(offerId, true, adRate);
        
        // Simulate retrieving intent when publishing
        const storedIntent = {
          offerId,
          enabled: true,
          adRate,
          createdAt: Date.now(),
        };
        
        (global.fetch as jest.Mock).mockImplementationOnce(() => 
          mockRedisResponse(JSON.stringify(storedIntent))
        );

        const retrieved = await getPromotionIntent(offerId);
        
        expect(retrieved).not.toBeNull();
        expect(retrieved!.offerId).toBe(offerId);
        expect(retrieved!.enabled).toBe(true);
        expect(retrieved!.adRate).toBe(adRate);
        
        // Simulate deleting intent after processing
        (global.fetch as jest.Mock).mockImplementationOnce(() => 
          mockRedisResponse(1)
        );

        await deletePromotionIntent(offerId);
        
        // Verify delete was called
        expect(global.fetch).toHaveBeenCalledTimes(4); // SET, EXPIRE, GET, DEL
      });

      it('should handle disabled promotion intent', async () => {
        const offerId = 'offer-disabled-test';
        
        // Store disabled intent
        (global.fetch as jest.Mock)
          .mockImplementationOnce(() => mockRedisResponse('OK'))
          .mockImplementationOnce(() => mockRedisResponse(1));

        await storePromotionIntent(offerId, false, 0);
        
        // Retrieve and verify disabled
        const storedIntent = {
          offerId,
          enabled: false,
          adRate: 0,
          createdAt: Date.now(),
        };
        
        (global.fetch as jest.Mock).mockImplementationOnce(() => 
          mockRedisResponse(JSON.stringify(storedIntent))
        );

        const retrieved = await getPromotionIntent(offerId);
        
        expect(retrieved).not.toBeNull();
        expect(retrieved!.enabled).toBe(false);
      });
    });
  });
});
