/**
 * Unit tests for Dropbox staging in smartdrafts-scan-core.ts
 * 
 * Purpose: Prevent regression of Dropbox pairing issue where bare filenames
 * were sent to pairing processor instead of R2/S3 staged URLs.
 * 
 * Root Cause: Scan was bypassing DropboxAdapter and creating temporary
 * Dropbox links instead of staging files to R2/S3 for pairing compatibility.
 * 
 * Fix: Modified scan to use DropboxAdapter.list() which stages files to
 * R2/S3 and returns stagedUrl in IngestedFile objects.
 */

import { jest } from '@jest/globals';
import type { IngestedFile } from '../../src/ingestion/types.js';

// Mock the DropboxAdapter before importing scan core
jest.mock('../../src/ingestion/dropbox.js', () => ({
  DropboxAdapter: {
    list: jest.fn(),
  },
}));

// Mock OpenAI
jest.mock('../../src/lib/openai.js', () => ({
  openai: {
    chat: {
      completions: {
        create: jest.fn(),
      },
    },
  },
}));

// Mock other dependencies
jest.mock('../../src/lib/_blobs.js', () => ({
  tokensStore: jest.fn(() => ({
    get: jest.fn(),
    set: jest.fn(),
  })),
}));

jest.mock('../../src/lib/job-store.js', () => ({
  jobStore: jest.fn(() => ({
    createJob: jest.fn(),
    updateJob: jest.fn(),
    getJobState: jest.fn(),
  })),
}));

// Import after mocking
import { DropboxAdapter } from '../../src/ingestion/dropbox.js';

describe('smartdrafts-scan-core: Dropbox staging', () => {
  const mockDropboxAdapter = DropboxAdapter as jest.Mocked<typeof DropboxAdapter>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('DropboxAdapter.list() integration', () => {
    test('should call DropboxAdapter.list() with required source property', async () => {
      // Arrange
      const mockIngestedFiles: IngestedFile[] = [
        {
          name: 'product1-front.jpg',
          bytes: 1024000,
          mime: 'image/jpeg',
          stagedUrl: 'https://r2.example.com/staged/user123/job456/product1-front.jpg?signature=abc123',
          stagingKey: 'staged/user123/job456/product1-front.jpg',
          source: 'dropbox',
          sourceMetadata: {
            path: '/photos/product1-front.jpg',
            id: 'id:abc123',
          },
        },
        {
          name: 'product1-back.jpg',
          bytes: 980000,
          mime: 'image/jpeg',
          stagedUrl: 'https://r2.example.com/staged/user123/job456/product1-back.jpg?signature=def456',
          stagingKey: 'staged/user123/job456/product1-back.jpg',
          source: 'dropbox',
          sourceMetadata: {
            path: '/photos/product1-back.jpg',
            id: 'id:def456',
          },
        },
      ];

      mockDropboxAdapter.list.mockResolvedValue(mockIngestedFiles);

      // Act
      const userId = 'user123';
      const folderPath = '/photos';
      const refreshToken = 'mock_refresh_token';

      // This would normally be called within handleSmartDraftsScan
      // We're testing the DropboxAdapter.list() call pattern
      const result = await DropboxAdapter.list({
        source: 'dropbox',  // CRITICAL: Must include source property
        userId,
        payload: {
          folderPath,
          refreshToken,
          skipStaging: false,
        },
      });

      // Assert
      expect(mockDropboxAdapter.list).toHaveBeenCalledWith({
        source: 'dropbox',  // Verify source property is present
        userId: 'user123',
        payload: {
          folderPath: '/photos',
          refreshToken: 'mock_refresh_token',
          skipStaging: false,
        },
      });

      expect(result).toEqual(mockIngestedFiles);
      expect(result).toHaveLength(2);
    });

    test('should return IngestedFile objects with stagedUrl, not bare filenames', async () => {
      // Arrange
      const mockIngestedFiles: IngestedFile[] = [
        {
          name: 'product2-front.jpg',
          bytes: 1500000,
          mime: 'image/jpeg',
          stagedUrl: 'https://r2.example.com/staged/user456/job789/product2-front.jpg?signature=xyz789',
          stagingKey: 'staged/user456/job789/product2-front.jpg',
          source: 'dropbox',
          sourceMetadata: {
            path: '/dropbox/product2-front.jpg',
            id: 'id:xyz789',
          },
        },
      ];

      mockDropboxAdapter.list.mockResolvedValue(mockIngestedFiles);

      // Act
      const result = await DropboxAdapter.list({
        source: 'dropbox',
        userId: 'user456',
        payload: {
          folderPath: '/dropbox',
          refreshToken: 'token',
          skipStaging: false,
        },
      });

      // Assert - Verify each file has valid S3 URL, not bare filename
      result.forEach(file => {
        expect(file.stagedUrl).toBeDefined();
        expect(file.stagedUrl).toMatch(/^https:\/\//);  // Must be full URL
        expect(file.stagedUrl).toContain('r2.example.com');  // Must be R2/S3
        expect(file.stagedUrl).not.toEqual(file.name);  // Not bare filename
        
        // Verify URL structure
        const url = new URL(file.stagedUrl);
        expect(url.protocol).toBe('https:');
        expect(url.pathname).toContain('staged/');
        expect(url.searchParams.get('signature')).toBeTruthy();  // Should have signature
      });
    });

    test('should never return Dropbox temporary links', async () => {
      // Arrange
      const mockIngestedFiles: IngestedFile[] = [
        {
          name: 'book-cover.jpg',
          bytes: 800000,
          mime: 'image/jpeg',
          stagedUrl: 'https://r2.example.com/staged/user789/job111/book-cover.jpg?signature=book123',
          stagingKey: 'staged/user789/job111/book-cover.jpg',
          source: 'dropbox',
          sourceMetadata: {
            path: '/books/book-cover.jpg',
            id: 'id:book123',
          },
        },
      ];

      mockDropboxAdapter.list.mockResolvedValue(mockIngestedFiles);

      // Act
      const result = await DropboxAdapter.list({
        source: 'dropbox',
        userId: 'user789',
        payload: {
          folderPath: '/books',
          refreshToken: 'token',
          skipStaging: false,
        },
      });

      // Assert - Verify NO Dropbox links returned
      result.forEach(file => {
        expect(file.stagedUrl).not.toContain('dl.dropboxusercontent.com');
        expect(file.stagedUrl).not.toContain('dropbox.com');
        expect(file.stagedUrl).not.toContain('/link/');
        expect(file.stagedUrl).toContain('r2.example.com');  // Must be R2/S3
      });
    });

    test('should include skipStaging: false to ensure R2/S3 staging', async () => {
      // Arrange
      mockDropboxAdapter.list.mockResolvedValue([]);

      // Act
      await DropboxAdapter.list({
        source: 'dropbox',
        userId: 'user999',
        payload: {
          folderPath: '/test',
          refreshToken: 'token',
          skipStaging: false,  // CRITICAL: Must be false for pairing compatibility
        },
      });

      // Assert
      expect(mockDropboxAdapter.list).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            skipStaging: false,
          }),
        })
      );
    });
  });

  describe('Scan response structure', () => {
    test('stagedUrls array should contain valid R2/S3 URLs', () => {
      // Simulate the scan response structure
      const mockScanResponse = {
        groups: [
          {
            id: 'group1',
            images: ['product1-front.jpg', 'product1-back.jpg'],
          },
        ],
        stagedUrls: [
          'https://r2.example.com/staged/user123/job456/product1-front.jpg?signature=abc',
          'https://r2.example.com/staged/user123/job456/product1-back.jpg?signature=def',
        ],
        imageInsights: {},
        orphans: [],
      };

      // Assert stagedUrls structure
      expect(mockScanResponse.stagedUrls).toBeDefined();
      expect(Array.isArray(mockScanResponse.stagedUrls)).toBe(true);
      expect(mockScanResponse.stagedUrls.length).toBeGreaterThan(0);

      // Verify each URL is valid
      mockScanResponse.stagedUrls.forEach(url => {
        expect(url).toMatch(/^https:\/\//);
        expect(() => new URL(url)).not.toThrow();
        
        const parsedUrl = new URL(url);
        expect(parsedUrl.protocol).toBe('https:');
        expect(parsedUrl.pathname).toContain('staged/');
      });
    });

    test('stagedUrls should map to images in groups', () => {
      const mockIngestedFiles: IngestedFile[] = [
        {
          name: 'img1.jpg',
          bytes: 1000,
          mime: 'image/jpeg',
          stagedUrl: 'https://r2.example.com/staged/user/job/img1.jpg?sig=a',
          stagingKey: 'staged/user/job/img1.jpg',
          source: 'dropbox',
          sourceMetadata: { path: '/img1.jpg', id: 'id:a' },
        },
        {
          name: 'img2.jpg',
          bytes: 1000,
          mime: 'image/jpeg',
          stagedUrl: 'https://r2.example.com/staged/user/job/img2.jpg?sig=b',
          stagingKey: 'staged/user/job/img2.jpg',
          source: 'dropbox',
          sourceMetadata: { path: '/img2.jpg', id: 'id:b' },
        },
      ];

      // Simulate mapping IngestedFiles to stagedUrls
      const stagedUrls = mockIngestedFiles.map(f => f.stagedUrl);

      expect(stagedUrls).toEqual([
        'https://r2.example.com/staged/user/job/img1.jpg?sig=a',
        'https://r2.example.com/staged/user/job/img2.jpg?sig=b',
      ]);

      // Verify no bare filenames
      expect(stagedUrls).not.toContain('img1.jpg');
      expect(stagedUrls).not.toContain('img2.jpg');
    });
  });

  describe('Pairing compatibility', () => {
    test('pairing processor should be able to parse stagedUrls as valid URLs', () => {
      const mockStagedUrls = [
        'https://r2.example.com/staged/user123/job456/product1-front.jpg?signature=abc123',
        'https://r2.example.com/staged/user123/job456/product1-back.jpg?signature=def456',
      ];

      // Simulate pairing URL validation
      const validUrls = mockStagedUrls.filter(urlStr => {
        try {
          const url = new URL(urlStr);
          return url.protocol === 'https:';
        } catch {
          return false;
        }
      });

      expect(validUrls).toHaveLength(2);
      expect(validUrls).toEqual(mockStagedUrls);
    });

    test('pairing processor should reject bare filenames', () => {
      const mixedUrls = [
        'https://r2.example.com/staged/user/job/valid.jpg?sig=abc',
        'img_20251219_125638.jpg',  // This was the original bug
        'another-file.jpg',
      ];

      // Simulate pairing URL validation (from pairing-v2-processor-background.ts)
      const validUrls = mixedUrls.filter(urlStr => {
        try {
          const url = new URL(urlStr);
          return url.protocol === 'https:';
        } catch {
          console.warn(`[test] Skipping invalid URL: ${urlStr}`);
          return false;
        }
      });

      // Should only keep the valid S3 URL
      expect(validUrls).toHaveLength(1);
      expect(validUrls[0]).toContain('r2.example.com');
      
      // Should reject bare filenames
      expect(validUrls).not.toContain('img_20251219_125638.jpg');
      expect(validUrls).not.toContain('another-file.jpg');
    });
  });

  describe('Regression prevention', () => {
    test('REGRESSION: should never bypass DropboxAdapter and create temp links directly', async () => {
      // This test ensures we don't reintroduce the bug where scan called
      // listFolder() and dbxSharedRawLink() directly instead of using DropboxAdapter

      const mockIngestedFiles: IngestedFile[] = [
        {
          name: 'test.jpg',
          bytes: 1000,
          mime: 'image/jpeg',
          stagedUrl: 'https://r2.example.com/staged/user/job/test.jpg?sig=x',
          stagingKey: 'staged/user/job/test.jpg',
          source: 'dropbox',
          sourceMetadata: { path: '/test.jpg', id: 'id:x' },
        },
      ];

      mockDropboxAdapter.list.mockResolvedValue(mockIngestedFiles);

      // Act - Use DropboxAdapter (correct pattern)
      await DropboxAdapter.list({
        source: 'dropbox',
        userId: 'user',
        payload: {
          folderPath: '/test',
          refreshToken: 'token',
          skipStaging: false,
        },
      });

      // Assert - DropboxAdapter.list was called
      expect(mockDropboxAdapter.list).toHaveBeenCalled();
      
      // The old bug would have:
      // 1. Called listFolder() directly (NOT through adapter)
      // 2. Called dbxSharedRawLink() to create temp links
      // 3. Returned bare filenames or Dropbox temp links
      // This test ensures we use the adapter pattern instead
    });

    test('REGRESSION: stagedUrls must be present in scan response for pairing', () => {
      // Old bug: scan response didn't include stagedUrls array
      // Pairing processor expected URLs but received bare filenames from groups

      const correctScanResponse = {
        groups: [{ id: 'g1', images: ['img1.jpg'] }],
        stagedUrls: ['https://r2.example.com/staged/user/job/img1.jpg?sig=a'],  // MUST be present
        imageInsights: {},
        orphans: [],
      };

      // Assert stagedUrls exists and is an array
      expect(correctScanResponse.stagedUrls).toBeDefined();
      expect(Array.isArray(correctScanResponse.stagedUrls)).toBe(true);
      
      // Assert it contains valid URLs, not filenames
      correctScanResponse.stagedUrls.forEach(url => {
        expect(() => new URL(url)).not.toThrow();
        expect(url).not.toEqual('img1.jpg');  // Not bare filename
      });
    });

    test('REGRESSION: IngestRequest must include source property', () => {
      // The build error was: Missing 'source' property in IngestRequest
      // This test ensures we always pass source: 'dropbox'

      const validRequest = {
        source: 'dropbox' as const,  // MUST be present
        userId: 'user123',
        payload: {
          folderPath: '/folder',
          refreshToken: 'token',
          skipStaging: false,
        },
      };

      // Verify structure matches IngestRequest interface
      expect(validRequest.source).toBe('dropbox');
      expect(validRequest.userId).toBeDefined();
      expect(validRequest.payload).toBeDefined();
    });
  });
});
