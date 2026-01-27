/**
 * Unit tests for smartdrafts-pairing-v2-start-from-scan.ts
 * 
 * Tests the bridge between scan jobs and pairing-v2 jobs
 * Critical scenarios:
 * - Empty folders (stagedUrls: [])
 * - Dropbox folders with images
 * - Local uploads with stagedUrls
 * - Missing stagedUrls and groups (error case)
 * - Fallback to groups when stagedUrls missing
 */

import { jest } from '@jest/globals';
import type { HandlerEvent, HandlerContext, HandlerResponse } from '@netlify/functions';

// Mock dependencies with proper typing
const mockRequireUserAuth = jest.fn<() => Promise<{ userId: string; email: string }>>();
const mockSchedulePairingV2Job = jest.fn<(...args: any[]) => Promise<string>>();
const mockGetJob = jest.fn<() => Promise<any>>();
const mockTokensStore = jest.fn<() => any>();
const mockFetch = jest.fn<() => Promise<any>>();

jest.mock('../../src/lib/auth-user.js', () => ({
  requireUserAuth: mockRequireUserAuth,
}));

jest.mock('../../src/lib/pairingV2Jobs.js', () => ({
  schedulePairingV2Job: mockSchedulePairingV2Job,
}));

jest.mock('../../src/lib/job-store.js', () => ({
  getJob: mockGetJob,
}));

jest.mock('../../src/lib/redis-store.js', () => ({
  tokensStore: mockTokensStore,
}));

jest.mock('../../src/lib/_auth.js', () => ({
  userScopedKey: jest.fn<(userId: string, key: string) => string>((userId: string, key: string) => `${userId}:${key}`),
}));

jest.mock('node-fetch', () => ({
  __esModule: true,
  default: mockFetch,
}));

describe('smartdrafts-pairing-v2-start-from-scan', () => {
  const mockUserAuth = {
    userId: 'test-user-123',
    email: 'test@example.com',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireUserAuth.mockResolvedValue(mockUserAuth);
    mockSchedulePairingV2Job.mockResolvedValue('pairing-job-456');
    mockTokensStore.mockReturnValue({
      get: jest.fn<() => Promise<any>>().mockResolvedValue({ refresh_token: 'mock_refresh' }),
    });
    
    // Set up env vars for Redis
    process.env.UPSTASH_REDIS_REST_URL = 'https://mock-redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
  });
  
  // Helper to mock Redis GET response
  function mockRedisGet(scanJob: any) {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: JSON.stringify(scanJob) }),
    });
  }

  describe('Empty folder handling', () => {
    test('should return jobId: null for empty stagedUrls array', async () => {
      // Arrange - Scan job with empty stagedUrls
      const scanJob = {
        jobId: 'scan-job-123',
        state: 'complete',
        folder: '/EBAY/empty-folder',
        stagedUrls: [], // Empty array
        groups: [],
        imageInsights: {},
      };

      mockRedisGet(scanJob);
      mockGetJob.mockResolvedValue(scanJob);

      // Act
      const { handler } = await import('../../netlify/functions/smartdrafts-pairing-v2-start-from-scan.js');
      const event = {
        httpMethod: 'POST',
        headers: {
          authorization: 'Bearer mock-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scanJobId: 'scan-job-123' }),
      } as Partial<HandlerEvent>;
      const context = {} as HandlerContext;
      const result = await handler(event as any, context) as HandlerResponse;

      // Assert
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body!);
      expect(body.jobId).toBe(null);
      expect(body.message).toContain('No images to pair');
      expect(body.pairs).toEqual([]);
      expect(body.unpaired).toEqual([]);

      // Should NOT schedule a pairing job
      expect(mockSchedulePairingV2Job).not.toHaveBeenCalled();
    });

    test('should return jobId: null when both stagedUrls and groups are empty', async () => {
      // Arrange
      const scanJob = {
        jobId: 'scan-job-empty',
        state: 'complete',
        folder: '/EBAY/test',
        stagedUrls: [],
        groups: [],
      };

      mockRedisGet(scanJob);
      mockGetJob.mockResolvedValue(scanJob);

      // Act
      const { handler } = await import('../../netlify/functions/smartdrafts-pairing-v2-start-from-scan.js');
      const event = {
        httpMethod: 'POST',
        headers: {
          authorization: 'Bearer mock-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scanJobId: 'scan-job-empty' }),
      } as Partial<HandlerEvent>;
      const context = {} as HandlerContext;
      const result = await handler(event as any, context) as HandlerResponse;

      // Assert
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body!);
      expect(body.jobId).toBe(null);
      expect(mockSchedulePairingV2Job).not.toHaveBeenCalled();
    });
  });

  describe('Dropbox folder with images', () => {
    test('should use stagedUrls from scan job', async () => {
      // Arrange
      const scanJob = {
        jobId: 'scan-job-dropbox',
        state: 'complete',
        folder: '/EBAY/products',
        stagedUrls: [
          'https://r2.example.com/staged/user/job/img1.jpg?sig=a',
          'https://r2.example.com/staged/user/job/img2.jpg?sig=b',
          'https://r2.example.com/staged/user/job/img3.jpg?sig=c',
        ],
        groups: [
          { id: 'g1', images: ['img1.jpg', 'img2.jpg'] },
          { id: 'g2', images: ['img3.jpg'] },
        ],
      };

      mockRedisGet(scanJob);
      mockGetJob.mockResolvedValue(scanJob);

      // Act
      const { handler } = await import('../../netlify/functions/smartdrafts-pairing-v2-start-from-scan.js');
      const event = {
        httpMethod: 'POST',
        headers: {
          authorization: 'Bearer mock-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scanJobId: 'scan-job-dropbox' }),
      } as Partial<HandlerEvent>;
      const context = {} as HandlerContext;
      const result = await handler(event as any, context) as HandlerResponse;

      // Assert
      expect(result.statusCode).toBe(202); // Accepted
      const body = JSON.parse(result.body!);
      expect(body.ok).toBe(true);
      expect(body.jobId).toBe('pairing-job-456');
      expect(body.imageCount).toBe(3);

      // Verify schedulePairingV2Job was called with stagedUrls
      expect(mockSchedulePairingV2Job).toHaveBeenCalledWith(
        'test-user-123',
        '/EBAY/products',
        scanJob.stagedUrls,
        undefined // No accessToken for local/staged URLs
      );
    });

    test('should schedule pairing job with correct parameters', async () => {
      // Arrange
      const stagedUrls = [
        'https://r2.example.com/staged/user123/job789/product1-front.jpg?sig=x',
        'https://r2.example.com/staged/user123/job789/product1-back.jpg?sig=y',
      ];

      const scanJob = {
        jobId: 'scan-789',
        state: 'complete',
        folder: '/EBAY/batch-1',
        stagedUrls,
        groups: [{ id: 'g1', images: ['product1-front.jpg', 'product1-back.jpg'] }],
      };

      mockRedisGet(scanJob);
      mockGetJob.mockResolvedValue(scanJob);
      mockSchedulePairingV2Job.mockResolvedValue('new-pairing-job-xyz');

      // Act
      const { handler } = await import('../../netlify/functions/smartdrafts-pairing-v2-start-from-scan.js');
      const event = {
        httpMethod: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scanJobId: 'scan-789' }),
      } as Partial<HandlerEvent>;
      const context = {} as HandlerContext;
      await handler(event as any, context);

      // Assert
      expect(mockSchedulePairingV2Job).toHaveBeenCalledTimes(1);
      expect(mockSchedulePairingV2Job).toHaveBeenCalledWith(
        'test-user-123',
        '/EBAY/batch-1',
        stagedUrls,
        undefined
      );
    });
  });

  describe('Fallback to groups when stagedUrls missing', () => {
    test('should extract URLs from groups when stagedUrls undefined', async () => {
      // Arrange - Old scan format without stagedUrls
      const scanJob = {
        jobId: 'scan-legacy',
        state: 'complete',
        folder: '/EBAY/legacy',
        // stagedUrls: undefined,
        groups: [
          { id: 'g1', images: ['https://example.com/img1.jpg', 'https://example.com/img2.jpg'] },
          { id: 'g2', images: ['https://example.com/img3.jpg'] },
        ],
      };

      mockRedisGet(scanJob);
      mockGetJob.mockResolvedValue(scanJob);

      // Act
      const { handler } = await import('../../netlify/functions/smartdrafts-pairing-v2-start-from-scan.js');
      const event = {
        httpMethod: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scanJobId: 'scan-legacy' }),
      } as Partial<HandlerEvent>;
      const context = {} as HandlerContext;
      const result = await handler(event as any, context) as HandlerResponse;

      // Assert
      expect(result.statusCode).toBe(202);
      expect(mockSchedulePairingV2Job).toHaveBeenCalledWith(
        'test-user-123',
        '/EBAY/legacy', // Uses actual folder from scanJob
        [
          'https://example.com/img1.jpg',
          'https://example.com/img2.jpg',
          'https://example.com/img3.jpg',
        ],
        undefined
      );
    });

    test('should flatten nested images from multiple groups', async () => {
      // Arrange
      const scanJob = {
        jobId: 'scan-multi',
        state: 'complete',
        groups: [
          { id: 'g1', images: ['url1', 'url2'] },
          { id: 'g2', images: ['url3'] },
          { id: 'g3', images: ['url4', 'url5', 'url6'] },
        ],
      };

      mockRedisGet(scanJob);
      mockGetJob.mockResolvedValue(scanJob);

      // Act
      const { handler } = await import('../../netlify/functions/smartdrafts-pairing-v2-start-from-scan.js');
      const event = {
        httpMethod: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ scanJobId: 'scan-multi' }),
      } as Partial<HandlerEvent>;
      const context = {} as HandlerContext;
      await handler(event as any, context);

      // Assert
      expect(mockSchedulePairingV2Job).toHaveBeenCalledWith(
        'test-user-123',
        'extracted-from-groups',
        ['url1', 'url2', 'url3', 'url4', 'url5', 'url6'],
        undefined
      );
    });
  });

  describe('Error handling', () => {
    test('should return 400 when both stagedUrls and groups are missing', async () => {
      // Arrange - Malformed scan job
      const scanJob = {
        jobId: 'scan-broken',
        state: 'complete',
        folder: '/EBAY/broken',
        // No stagedUrls, no groups
      };

      mockRedisGet(scanJob);
      mockGetJob.mockResolvedValue(scanJob);

      // Act
      const { handler } = await import('../../netlify/functions/smartdrafts-pairing-v2-start-from-scan.js');
      const event = {
        httpMethod: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ scanJobId: 'scan-broken' }),
      } as Partial<HandlerEvent>;
      const context = {} as HandlerContext;
      const result = await handler(event as any, context) as HandlerResponse;

      // Assert
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body!);
      expect(body.error).toContain('no image data');
      expect(mockSchedulePairingV2Job).not.toHaveBeenCalled();
    });

    test('should return 404 when scan job not found', async () => {
      // Arrange
      mockRedisGet(null);
      mockGetJob.mockResolvedValue(null);

      // Act
      const { handler } = await import('../../netlify/functions/smartdrafts-pairing-v2-start-from-scan.js');
      const event = {
        httpMethod: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ scanJobId: 'nonexistent' }),
      } as Partial<HandlerEvent>;
      const context = {} as HandlerContext;
      const result = await handler(event as any, context) as HandlerResponse;

      // Assert
      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body!);
      expect(body.error).toContain('Scan job not found');
    });

    test('should return 400 when scanJobId missing', async () => {
      // Act
      const { handler } = await import('../../netlify/functions/smartdrafts-pairing-v2-start-from-scan.js');
      const event = {
        httpMethod: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({}), // No scanJobId
      } as Partial<HandlerEvent>;
      const context = {} as HandlerContext;
      const result = await handler(event as any, context) as HandlerResponse;

      // Assert
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body!);
      expect(body.error).toContain('scanJobId');
    });

    test('should return 401 when auth fails', async () => {
      // Arrange
      mockRequireUserAuth.mockRejectedValue(new Error('Invalid token'));

      // Act
      const { handler } = await import('../../netlify/functions/smartdrafts-pairing-v2-start-from-scan.js');
      const event = {
        httpMethod: 'POST',
        headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' },
        body: JSON.stringify({ scanJobId: 'scan-123' }),
      } as Partial<HandlerEvent>;
      const context = {} as HandlerContext;
      const result = await handler(event as any, context) as HandlerResponse;

      // Assert
      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body!);
      expect(body.error).toContain('Unauthorized');
    });

    test('should return 500 when schedulePairingV2Job fails', async () => {
      // Arrange
      const scanJob = {
        jobId: 'scan-will-fail',
        state: 'complete',
        folder: '/EBAY/test',
        stagedUrls: ['url1', 'url2'],
      };

      mockRedisGet(scanJob);
      mockGetJob.mockResolvedValue(scanJob);
      mockSchedulePairingV2Job.mockRejectedValue(new Error('Redis connection failed'));

      // Act
      const { handler } = await import('../../netlify/functions/smartdrafts-pairing-v2-start-from-scan.js');
      const event = {
        httpMethod: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ scanJobId: 'scan-will-fail' }),
      } as Partial<HandlerEvent>;
      const context = {} as HandlerContext;
      const result = await handler(event as any, context) as HandlerResponse;

      // Assert
      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body!);
      expect(body.error).toContain('Redis connection failed');
    });
  });

  describe('OPTIONS request handling', () => {
    test('should return 200 for OPTIONS preflight', async () => {
      // Act
      const { handler } = await import('../../netlify/functions/smartdrafts-pairing-v2-start-from-scan.js');
      const event = {
        httpMethod: 'OPTIONS',
        headers: {},
      } as Partial<HandlerEvent>;
      const context = {} as HandlerContext;
      const result = await handler(event as any, context) as HandlerResponse;

      // Assert
      expect(result.statusCode).toBe(200);
      expect(result.headers).toMatchObject({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': expect.stringContaining('POST'),
      });
    });
  });

  describe('Upload method detection', () => {
    test('should report uploadMethod as "local" when stagedUrls present', async () => {
      // Arrange
      const scanJob = {
        jobId: 'scan-local',
        state: 'complete',
        folder: 'local-upload',
        stagedUrls: ['https://r2.example.com/uploads/file1.jpg'],
      };

      mockRedisGet(scanJob);
      mockGetJob.mockResolvedValue(scanJob);

      // Act
      const { handler } = await import('../../netlify/functions/smartdrafts-pairing-v2-start-from-scan.js');
      const event = {
        httpMethod: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ scanJobId: 'scan-local' }),
      } as Partial<HandlerEvent>;
      const context = {} as HandlerContext;
      const result = await handler(event as any, context) as HandlerResponse;

      // Assert
      const body = JSON.parse(result.body!);
      expect(body.uploadMethod).toBe('local');
    });

    test('should report uploadMethod as "dropbox" when using groups fallback', async () => {
      // Arrange
      const scanJob = {
        jobId: 'scan-dbx',
        state: 'complete',
        groups: [{ id: 'g1', images: ['img.jpg'] }],
      };

      mockRedisGet(scanJob);
      mockGetJob.mockResolvedValue(scanJob);

      // Act
      const { handler } = await import('../../netlify/functions/smartdrafts-pairing-v2-start-from-scan.js');
      const event = {
        httpMethod: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ scanJobId: 'scan-dbx' }),
      } as Partial<HandlerEvent>;
      const context = {} as HandlerContext;
      const result = await handler(event as any, context) as HandlerResponse;

      // Assert
      const body = JSON.parse(result.body!);
      expect(body.uploadMethod).toBe('dropbox');
    });
  });

  describe('REGRESSION tests', () => {
    test('REGRESSION: should use stagedUrls, not groups.images, when both present', async () => {
      // This was a bug where groups.images contained bare filenames
      // but stagedUrls contained full R2/S3 URLs
      const scanJob = {
        jobId: 'scan-regression',
        state: 'complete',
        folder: '/EBAY/test',
        stagedUrls: [
          'https://r2.example.com/staged/user/job/img1.jpg?sig=a',
          'https://r2.example.com/staged/user/job/img2.jpg?sig=b',
        ],
        groups: [
          { id: 'g1', images: ['img1.jpg', 'img2.jpg'] }, // Bare filenames
        ],
      };

      mockRedisGet(scanJob);
      mockGetJob.mockResolvedValue(scanJob);

      // Act
      const { handler } = await import('../../netlify/functions/smartdrafts-pairing-v2-start-from-scan.js');
      const event = {
        httpMethod: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ scanJobId: 'scan-regression' }),
      } as Partial<HandlerEvent>;
      const context = {} as HandlerContext;
      await handler(event as any, context);

      // Assert - Should use stagedUrls (full URLs), NOT groups.images (bare filenames)
      expect(mockSchedulePairingV2Job).toHaveBeenCalledWith(
        'test-user-123',
        '/EBAY/test',
        scanJob.stagedUrls, // Full R2/S3 URLs
        undefined
      );

      // Verify it did NOT use bare filenames
      const calledWith = (mockSchedulePairingV2Job.mock.calls[0] as any[])[2];
      expect(calledWith).not.toContain('img1.jpg');
      expect(calledWith).not.toContain('img2.jpg');
    });

    test('REGRESSION: empty folder should not throw error', async () => {
      // Bug: Empty folders caused pairing to fail with "Failed to start pairing"
      const scanJob = {
        jobId: 'scan-empty-regression',
        state: 'complete',
        folder: '/EBAY/empty',
        stagedUrls: [],
        groups: [],
      };

      mockRedisGet(scanJob);
      mockGetJob.mockResolvedValue(scanJob);

      // Act
      const { handler } = await import('../../netlify/functions/smartdrafts-pairing-v2-start-from-scan.js');
      const event = {
        httpMethod: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ scanJobId: 'scan-empty-regression' }),
      } as Partial<HandlerEvent>;
      const context = {} as HandlerContext;
      const result = await handler(event as any, context) as HandlerResponse;

      // Assert - Should NOT throw, should return graceful response
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body!);
      expect(body.jobId).toBe(null);
      expect(body.message).toBeTruthy();
      expect(body).toHaveProperty('pairs');
      expect(body).toHaveProperty('unpaired');
    });
  });
});
