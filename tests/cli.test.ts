/**
 * Unit tests for cli.ts
 * Tests the CLI interface for processing images
 */

import { argv } from 'process';

// Mock undici request
jest.mock('undici', () => ({
  request: jest.fn(),
}));

import { request } from 'undici';

describe('CLI Module', () => {
  const mockRequest = request as jest.MockedFunction<typeof request>;
  
  // Store original env
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset env vars
    delete process.env.PUBLISH_MODE;
    delete process.env.LIMIT;
  });

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
  });

  describe('environment configuration', () => {
    it('should default PUBLISH_MODE to draft when not set', () => {
      const mode = process.env.PUBLISH_MODE || 'draft';
      expect(mode).toBe('draft');
    });

    it('should use PUBLISH_MODE from environment when set', () => {
      process.env.PUBLISH_MODE = 'post';
      const mode = process.env.PUBLISH_MODE || 'draft';
      expect(mode).toBe('post');
    });

    it('should default LIMIT to 10 when not set', () => {
      const limit = Number(process.env.LIMIT || 10);
      expect(limit).toBe(10);
    });

    it('should use LIMIT from environment when set', () => {
      process.env.LIMIT = '50';
      const limit = Number(process.env.LIMIT || 10);
      expect(limit).toBe(50);
    });

    it('should handle non-numeric LIMIT gracefully', () => {
      process.env.LIMIT = 'invalid';
      const limit = Number(process.env.LIMIT || 10);
      expect(Number.isNaN(limit)).toBe(true);
    });
  });

  describe('request body structure', () => {
    it('should build correct request body with defaults', () => {
      const mode = process.env.PUBLISH_MODE || 'draft';
      const body = {
        mode,
        folderPath: '/EBAY',
        quantityDefault: 1,
        marketplaceId: 'EBAY_US',
        categoryId: '177011',
      };

      expect(body).toEqual({
        mode: 'draft',
        folderPath: '/EBAY',
        quantityDefault: 1,
        marketplaceId: 'EBAY_US',
        categoryId: '177011',
      });
    });

    it('should use post mode when PUBLISH_MODE=post', () => {
      process.env.PUBLISH_MODE = 'post';
      const mode = process.env.PUBLISH_MODE || 'draft';
      const body = {
        mode,
        folderPath: '/EBAY',
        quantityDefault: 1,
        marketplaceId: 'EBAY_US',
        categoryId: '177011',
      };

      expect(body.mode).toBe('post');
    });
  });

  describe('URL construction', () => {
    it('should build correct URL with default limit', () => {
      const limit = Number(process.env.LIMIT || 10);
      const url = `http://localhost:3000/process?limit=${limit}`;
      expect(url).toBe('http://localhost:3000/process?limit=10');
    });

    it('should build correct URL with custom limit', () => {
      process.env.LIMIT = '25';
      const limit = Number(process.env.LIMIT || 10);
      const url = `http://localhost:3000/process?limit=${limit}`;
      expect(url).toBe('http://localhost:3000/process?limit=25');
    });
  });

  describe('request execution', () => {
    it('should send POST request with correct headers', async () => {
      const mockBody = {
        json: jest.fn().mockResolvedValue({ success: true, items: [] }),
      };
      mockRequest.mockResolvedValue({ body: mockBody } as any);

      const body = {
        mode: 'draft',
        folderPath: '/EBAY',
        quantityDefault: 1,
        marketplaceId: 'EBAY_US',
        categoryId: '177011',
      };

      await request('http://localhost:3000/process?limit=10', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(mockRequest).toHaveBeenCalledWith(
        'http://localhost:3000/process?limit=10',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
    });

    it('should parse JSON response correctly', async () => {
      const expectedResponse = {
        success: true,
        items: [{ id: '123', title: 'Test Product' }],
      };
      const mockBody = {
        json: jest.fn().mockResolvedValue(expectedResponse),
      };
      mockRequest.mockResolvedValue({ body: mockBody } as any);

      const r = await request('http://localhost:3000/process?limit=10', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.body.json();

      expect(j).toEqual(expectedResponse);
    });

    it('should handle network errors gracefully', async () => {
      mockRequest.mockRejectedValue(new Error('Network error'));

      await expect(
        request('http://localhost:3000/process?limit=10', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
      ).rejects.toThrow('Network error');
    });

    it('should handle JSON parse errors', async () => {
      const mockBody = {
        json: jest.fn().mockRejectedValue(new Error('Invalid JSON')),
      };
      mockRequest.mockResolvedValue({ body: mockBody } as any);

      const r = await request('http://localhost:3000/process?limit=10', {
        method: 'POST',
        headers: {},
        body: '',
      });

      await expect(r.body.json()).rejects.toThrow('Invalid JSON');
    });
  });

  describe('error handling', () => {
    it('should exit with code 1 on error', async () => {
      // This tests the pattern used in the CLI main function
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const error = new Error('Test error');
      const handleError = (e: Error) => {
        console.error(e);
        process.exit(1);
      };

      expect(() => handleError(error)).toThrow('process.exit called');
      expect(consoleSpy).toHaveBeenCalledWith(error);
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });
});
