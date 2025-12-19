/**
 * Integration tests for smartdrafts-scan-background.ts
 * 
 * Purpose: Ensure scan background worker correctly stores stagedUrls from scan response
 * 
 * Critical Bug: Worker was storing stagedUrls from INPUT payload (empty for Dropbox)
 * instead of OUTPUT payload (populated after staging to R2/S3)
 */

import { jest } from '@jest/globals';

// Mock dependencies
const mockPutJob = jest.fn();
const mockDecRunning = jest.fn();
const mockRunSmartDraftScan = jest.fn();

jest.mock('../../src/lib/job-store.js', () => ({
  putJob: mockPutJob,
  redisSet: jest.fn(),
}));

jest.mock('../../src/lib/quota.js', () => ({
  decRunning: mockDecRunning,
}));

jest.mock('../../src/lib/smartdrafts-scan-core.js', () => ({
  runSmartDraftScan: mockRunSmartDraftScan,
}));

jest.mock('../../src/lib/smartdrafts-metrics.js', () => ({
  newMetrics: jest.fn(() => ({})),
  logMetrics: jest.fn(),
}));

jest.mock('../../src/config.js', () => ({
  USE_CLIP: true,
  USE_NEW_SORTER: true,
  USE_ROLE_SORTING: true,
}));

jest.mock('../../src/config/smartdrafts.js', () => ({
  config: {
    visionConcurrency: 2,
    visionDownscaleEnabled: true,
  },
}));

describe('smartdrafts-scan-background: stagedUrls handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPutJob.mockResolvedValue(undefined);
    mockDecRunning.mockResolvedValue(undefined);
  });

  test('CRITICAL: must store stagedUrls from scan RESPONSE, not input', async () => {
    // Arrange - Simulate Dropbox scan (no input stagedUrls)
    const inputPayload = {
      jobId: 'test-job-123',
      userId: 'user-456',
      folder: '/EBAY/test-folder',
      stagedUrls: undefined, // Input has NO stagedUrls (Dropbox path-based scan)
      force: false,
      limit: 100,
      debug: false,
    };

    // Mock scan response with stagedUrls populated AFTER staging
    const scanResponse = {
      status: 200,
      body: {
        ok: true,
        folder: '/EBAY/test-folder',
        signature: 'abc123',
        count: 2,
        groups: [
          { id: 'g1', images: ['img1.jpg'] },
          { id: 'g2', images: ['img2.jpg'] },
        ],
        orphans: [],
        imageInsights: {},
        stagedUrls: [
          'https://r2.example.com/staged/user-456/test-job-123/img1.jpg?sig=x',
          'https://r2.example.com/staged/user-456/test-job-123/img2.jpg?sig=y',
        ],
        cached: false,
      },
    };

    mockRunSmartDraftScan.mockResolvedValue(scanResponse);

    // Act - Import and run handler
    const { handler } = await import('../../netlify/functions/smartdrafts-scan-background.js');
    await handler({
      body: JSON.stringify(inputPayload),
      headers: {},
      httpMethod: 'POST',
    } as any);

    // Assert - Verify putJob was called with stagedUrls from RESPONSE
    expect(mockPutJob).toHaveBeenCalledWith(
      'test-job-123',
      expect.objectContaining({
        state: 'complete',
        folder: '/EBAY/test-folder',
        stagedUrls: scanResponse.body.stagedUrls, // MUST be from response, not input
        groups: scanResponse.body.groups,
      }),
      expect.any(Object)
    );

    // Verify stagedUrls is the array from scan response
    const actualCall = mockPutJob.mock.calls.find((call: any) => 
      call[1]?.state === 'complete'
    );
    expect(actualCall).toBeDefined();
    expect(actualCall![1].stagedUrls).toEqual([
      'https://r2.example.com/staged/user-456/test-job-123/img1.jpg?sig=x',
      'https://r2.example.com/staged/user-456/test-job-123/img2.jpg?sig=y',
    ]);
  });

  test('REGRESSION: empty stagedUrls from response should be stored as empty array', async () => {
    // Arrange - Empty folder scan
    const inputPayload = {
      jobId: 'empty-job',
      userId: 'user-789',
      folder: '/EBAY/empty',
      stagedUrls: undefined,
      force: false,
      limit: 100,
      debug: false,
    };

    const scanResponse = {
      status: 200,
      body: {
        ok: true,
        folder: '/EBAY/empty',
        signature: null,
        count: 0,
        groups: [],
        orphans: [],
        imageInsights: {},
        stagedUrls: [], // Empty array (not undefined)
        warnings: ['No images found in folder.'],
      },
    };

    mockRunSmartDraftScan.mockResolvedValue(scanResponse);

    // Act
    const { handler } = await import('../../netlify/functions/smartdrafts-scan-background.js');
    await handler({
      body: JSON.stringify(inputPayload),
      headers: {},
      httpMethod: 'POST',
    } as any);

    // Assert - stagedUrls should be empty array, not undefined
    const actualCall = mockPutJob.mock.calls.find((call: any) => 
      call[1]?.state === 'complete'
    );
    expect(actualCall).toBeDefined();
    expect(actualCall![1].stagedUrls).toEqual([]); // Empty array
    expect(Array.isArray(actualCall![1].stagedUrls)).toBe(true);
  });

  test('REGRESSION: local upload with input stagedUrls should use response stagedUrls', async () => {
    // Arrange - Local upload may have stagedUrls in input too
    const inputStagedUrls = [
      'https://r2.example.com/uploads/temp1.jpg',
      'https://r2.example.com/uploads/temp2.jpg',
    ];

    const inputPayload = {
      jobId: 'local-job',
      userId: 'user-local',
      folder: undefined,
      stagedUrls: inputStagedUrls, // Input has stagedUrls
      force: false,
      limit: 100,
      debug: false,
    };

    // Scan may normalize/deduplicate URLs
    const scanResponse = {
      status: 200,
      body: {
        ok: true,
        folder: 'local-upload',
        signature: 'def456',
        count: 2,
        groups: [{ id: 'g1', images: ['temp1.jpg', 'temp2.jpg'] }],
        orphans: [],
        imageInsights: {},
        stagedUrls: inputStagedUrls, // Response returns same URLs (may differ in real scenario)
      },
    };

    mockRunSmartDraftScan.mockResolvedValue(scanResponse);

    // Act
    const { handler } = await import('../../netlify/functions/smartdrafts-scan-background.js');
    await handler({
      body: JSON.stringify(inputPayload),
      headers: {},
      httpMethod: 'POST',
    } as any);

    // Assert - Should use response stagedUrls, not input
    const actualCall = mockPutJob.mock.calls.find((call: any) => 
      call[1]?.state === 'complete'
    );
    expect(actualCall).toBeDefined();
    expect(actualCall![1].stagedUrls).toBe(scanResponse.body.stagedUrls);
  });

  test('scan failure should not store stagedUrls', async () => {
    // Arrange - Scan fails
    const inputPayload = {
      jobId: 'fail-job',
      userId: 'user-fail',
      folder: '/EBAY/broken',
      force: false,
      limit: 100,
      debug: false,
    };

    const scanResponse = {
      status: 500,
      body: {
        ok: false,
        error: 'Scan failed due to API error',
      },
    };

    mockRunSmartDraftScan.mockResolvedValue(scanResponse);

    // Act
    const { handler } = await import('../../netlify/functions/smartdrafts-scan-background.js');
    await handler({
      body: JSON.stringify(inputPayload),
      headers: {},
      httpMethod: 'POST',
    } as any);

    // Assert - Error state should not have stagedUrls
    const errorCall = mockPutJob.mock.calls.find((call: any) => 
      call[1]?.state === 'error'
    );
    expect(errorCall).toBeDefined();
    expect(errorCall![1].error).toContain('Scan failed');
    expect(errorCall![1].stagedUrls).toBeUndefined();
  });

  test('worker should call decRunning after completion', async () => {
    // Arrange
    const inputPayload = {
      jobId: 'quota-job',
      userId: 'user-quota',
      folder: '/EBAY/test',
      force: false,
      limit: 100,
      debug: false,
    };

    const scanResponse = {
      status: 200,
      body: {
        ok: true,
        folder: '/EBAY/test',
        signature: 'xyz',
        count: 1,
        groups: [{ id: 'g1', images: ['img.jpg'] }],
        orphans: [],
        imageInsights: {},
        stagedUrls: ['https://r2.example.com/staged/img.jpg'],
      },
    };

    mockRunSmartDraftScan.mockResolvedValue(scanResponse);

    // Act
    const { handler } = await import('../../netlify/functions/smartdrafts-scan-background.js');
    await handler({
      body: JSON.stringify(inputPayload),
      headers: {},
      httpMethod: 'POST',
    } as any);

    // Assert - decRunning should be called to release quota
    expect(mockDecRunning).toHaveBeenCalledWith('user-quota');
  });
});
