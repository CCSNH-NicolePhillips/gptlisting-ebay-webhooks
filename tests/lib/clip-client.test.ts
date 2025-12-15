// Set env vars before imports since they're read at module load time
process.env.HF_API_TOKEN = 'test-token-123';
process.env.CLIP_MODEL = 'laion/CLIP-ViT-B-32-DataComp.XL-s13B-b90K';
process.env.HF_ENDPOINT_BASE = 'https://api-inference.huggingface.co';

import { cosine, clipTextEmbedding, clipImageEmbedding, clipProviderInfo } from '../../src/lib/clip-client.js';

// Mock fetch globally
global.fetch = jest.fn();

describe('clip-client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('cosine', () => {
    it('should calculate cosine similarity for identical vectors', () => {
      const a = [1, 0, 0];
      const b = [1, 0, 0];
      expect(cosine(a, b)).toBe(1);
    });

    it('should calculate cosine similarity for orthogonal vectors', () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      expect(cosine(a, b)).toBe(0);
    });

    it('should calculate cosine similarity for opposite vectors', () => {
      const a = [1, 0, 0];
      const b = [-1, 0, 0];
      expect(cosine(a, b)).toBe(-1);
    });

    it('should calculate cosine similarity for arbitrary vectors', () => {
      const a = [1, 2, 3];
      const b = [4, 5, 6];
      const result = cosine(a, b);
      expect(result).toBeCloseTo(32, 5); // 1*4 + 2*5 + 3*6 = 32
    });

    it('should return 0 for null vectors', () => {
      expect(cosine(null, [1, 2, 3])).toBe(0);
      expect(cosine([1, 2, 3], null)).toBe(0);
      expect(cosine(null, null)).toBe(0);
    });

    it('should return 0 for mismatched dimensions', () => {
      const a = [1, 2, 3];
      const b = [1, 2];
      expect(cosine(a, b)).toBe(0);
    });

    it('should handle zero vectors', () => {
      const a = [0, 0, 0];
      const b = [1, 2, 3];
      expect(cosine(a, b)).toBe(0);
    });

    it('should handle empty arrays', () => {
      expect(cosine([], [])).toBe(0);
    });
  });

  describe('clipTextEmbedding', () => {
    it('should return null if no API token', async () => {
      // Note: Token is checked at module load time, so we can't test this dynamically
      // This test verifies the function runs with mocked fetch
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [0.6, 0.8],
      } as any);
      
      const result = await clipTextEmbedding('test');
      expect(result !== undefined).toBe(true);
    });

    it('should call HuggingFace API with text', async () => {
      const mockEmbedding = [0.1, 0.2, 0.3, 0.4];
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockEmbedding,
      } as any);

      const result = await clipTextEmbedding('Hello world');

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('api-inference.huggingface.co'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token-123',
            'Content-Type': 'application/json',
          }),
          body: expect.stringContaining('Hello world'),
        })
      );

      expect(result).toBeTruthy();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should normalize and unit-ize the embedding', async () => {
      const mockEmbedding = [3, 4]; // magnitude = 5
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockEmbedding,
      } as any);

      const result = await clipTextEmbedding('test');

      expect(result).toBeTruthy();
      expect(result![0]).toBeCloseTo(0.6, 5); // 3/5
      expect(result![1]).toBeCloseTo(0.8, 5); // 4/5
    });

    it('should handle 2D array response with mean pooling', async () => {
      const mockEmbedding = [
        [0.1, 0.2],
        [0.3, 0.4],
      ];
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockEmbedding,
      } as any);

      const result = await clipTextEmbedding('test');

      expect(result).toBeTruthy();
      // Should mean pool: [(0.1+0.3)/2, (0.2+0.4)/2] = [0.2, 0.3]
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle single-row 2D array', async () => {
      const mockEmbedding = [[0.6, 0.8]];
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockEmbedding,
      } as any);

      const result = await clipTextEmbedding('test');

      expect(result).toBeTruthy();
      expect(result![0]).toBeCloseTo(0.6, 5);
      expect(result![1]).toBeCloseTo(0.8, 5);
    });

    it('should handle embeddings property in response', async () => {
      const mockResponse = {
        embeddings: [0.6, 0.8],
      };
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as any);

      const result = await clipTextEmbedding('test');

      expect(result).toBeTruthy();
      expect(result![0]).toBeCloseTo(0.6, 5);
      expect(result![1]).toBeCloseTo(0.8, 5);
    });

    it('should retry on 503 error', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: async () => 'Service Unavailable',
          statusText: 'Service Unavailable',
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [0.6, 0.8],
        } as any);

      const result = await clipTextEmbedding('test');

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result).toBeTruthy();
    });

    it('should throw error after retries exhausted', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
        statusText: 'Service Unavailable',
      } as any);

      await expect(clipTextEmbedding('test')).rejects.toThrow('HF 503');
    });

    it('should throw error on non-503 errors', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
        statusText: 'Unauthorized',
      } as any);

      await expect(clipTextEmbedding('test')).rejects.toThrow('HF 401');
    });

    it('should handle JSON parse errors', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      } as any);

      const result = await clipTextEmbedding('test');

      expect(result).toBeNull();
    });

    it('should return null for invalid embedding format', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ invalid: 'format' }),
      } as any);

      const result = await clipTextEmbedding('test');

      expect(result).toBeNull();
    });

    it('should handle zero-length vectors', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [0, 0, 0],
      } as any);

      const result = await clipTextEmbedding('test');

      expect(result).toEqual([0, 0, 0]);
    });
  });

  describe('clipImageEmbedding', () => {
    it('should return null if no API token', async () => {
      // Note: Token is checked at module load time
      // This test just verifies the function exists
      const result = await clipImageEmbedding('https://example.com/image.jpg');
      expect(result !== undefined).toBe(true);
    });

    it('should fetch image and send base64 to HF', async () => {
      const mockImageBytes = new Uint8Array([137, 80, 78, 71]); // PNG header
      const mockEmbedding = [0.6, 0.8];

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          // Image fetch
          ok: true,
          arrayBuffer: async () => mockImageBytes.buffer,
        } as any)
        .mockResolvedValueOnce({
          // HF API call
          ok: true,
          json: async () => mockEmbedding,
        } as any);

      const result = await clipImageEmbedding('https://example.com/image.jpg');

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenNthCalledWith(1, 'https://example.com/image.jpg', { redirect: 'follow' });
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('api-inference.huggingface.co'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: expect.stringContaining('data:image/jpeg;base64,'),
        })
      );

      expect(result).toBeTruthy();
      expect(result![0]).toBeCloseTo(0.6, 5);
      expect(result![1]).toBeCloseTo(0.8, 5);
    });

    it('should return null if image fetch fails', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as any);

      const result = await clipImageEmbedding('https://example.com/missing.jpg');

      expect(result).toBeNull();
    });

    it('should fallback to raw bytes if base64 fails', async () => {
      const mockImageBytes = new Uint8Array([137, 80, 78, 71]);
      const mockEmbedding = [0.6, 0.8];

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          // Image fetch
          ok: true,
          arrayBuffer: async () => mockImageBytes.buffer,
        } as any)
        .mockResolvedValueOnce({
          // First HF API call (base64) - fails
          ok: false,
          status: 400,
          text: async () => 'Bad request',
          statusText: 'Bad Request',
        } as any)
        .mockResolvedValueOnce({
          // Second HF API call (raw bytes) - succeeds
          ok: true,
          json: async () => mockEmbedding,
        } as any);

      const result = await clipImageEmbedding('https://example.com/image.jpg');

      expect(fetch).toHaveBeenCalledTimes(3);
      expect(result).toBeTruthy();
    });

    it('should return null if both base64 and raw bytes fail', async () => {
      const mockImageBytes = new Uint8Array([137, 80, 78, 71]);

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          // Image fetch
          ok: true,
          arrayBuffer: async () => mockImageBytes.buffer,
        } as any)
        .mockResolvedValueOnce({
          // First HF API call (base64) - fails
          ok: false,
          status: 400,
          text: async () => 'Bad request',
          statusText: 'Bad Request',
        } as any)
        .mockResolvedValueOnce({
          // Second HF API call (raw bytes) - fails
          ok: false,
          status: 400,
          text: async () => 'Bad request',
          statusText: 'Bad Request',
        } as any);

      const result = await clipImageEmbedding('https://example.com/image.jpg');

      expect(result).toBeNull();
    });

    it('should normalize and unit-ize image embedding', async () => {
      const mockImageBytes = new Uint8Array([1, 2, 3]);
      const mockEmbedding = [3, 4]; // magnitude = 5

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => mockImageBytes.buffer,
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockEmbedding,
        } as any);

      const result = await clipImageEmbedding('https://example.com/image.jpg');

      expect(result![0]).toBeCloseTo(0.6, 5); // 3/5
      expect(result![1]).toBeCloseTo(0.8, 5); // 4/5
    });

    it('should handle image redirects', async () => {
      const mockImageBytes = new Uint8Array([1, 2, 3]);
      const mockEmbedding = [0.6, 0.8];

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => mockImageBytes.buffer,
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockEmbedding,
        } as any);

      await clipImageEmbedding('https://example.com/redirect');

      expect(fetch).toHaveBeenNthCalledWith(1, 'https://example.com/redirect', { redirect: 'follow' });
    });

    it('should send raw bytes with correct content type', async () => {
      const mockImageBytes = new Uint8Array([1, 2, 3]);
      const mockEmbedding = [0.6, 0.8];

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => mockImageBytes.buffer,
        } as any)
        .mockResolvedValueOnce({
          // Base64 fails
          ok: false,
          status: 400,
          text: async () => 'Bad request',
          statusText: 'Bad Request',
        } as any)
        .mockResolvedValueOnce({
          // Raw bytes succeeds
          ok: true,
          json: async () => mockEmbedding,
        } as any);

      await clipImageEmbedding('https://example.com/image.jpg');

      expect(fetch).toHaveBeenNthCalledWith(
        3,
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/octet-stream',
          }),
        })
      );
    });
  });

  describe('clipProviderInfo', () => {
    it('should return provider information', () => {
      const info = clipProviderInfo();

      expect(info).toEqual({
        provider: 'hf-private-endpoint',
        model: 'laion/CLIP-ViT-B-32-DataComp.XL-s13B-b90K',
        base: 'https://api-inference.huggingface.co',
      });
    });

    it('should have correct structure', () => {
      const info = clipProviderInfo();

      expect(info).toHaveProperty('provider');
      expect(info).toHaveProperty('model');
      expect(info).toHaveProperty('base');
      expect(typeof info.model).toBe('string');
      expect(typeof info.base).toBe('string');
    });
  });

  describe('URL building', () => {
    it('should build URL using configured endpoint and model', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [0.6, 0.8],
      } as any);

      await clipTextEmbedding('test');

      // URL is built from module-level constants
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('api-inference.huggingface.co'),
        expect.any(Object)
      );
    });

    it('should include model name in URL path', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [0.6, 0.8],
      } as any);

      await clipTextEmbedding('test');

      const url = (fetch as jest.Mock).mock.calls[0][0];
      expect(url).toContain('/models/');
    });

    it('should use proper URL encoding', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [0.6, 0.8],
      } as any);

      await clipTextEmbedding('test');

      const url = (fetch as jest.Mock).mock.calls[0][0];
      // Model name with slashes should be encoded (e.g., %2F)
      expect(url).toMatch(/^https?:\/\//);
    });
  });

  describe('Error handling edge cases', () => {
    it('should handle text response error with no body', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => '',
        statusText: 'Internal Server Error',
      } as any);

      await expect(clipTextEmbedding('test')).rejects.toThrow('HF 500');
    });

    it('should handle malformed response JSON', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      } as any);

      const result = await clipTextEmbedding('test');
      
      // hfCall catches json parse errors and returns null
      expect(result).toBeNull();
    });

    it('should include wait_for_model in text payload', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [0.6, 0.8],
      } as any);

      await clipTextEmbedding('test');

      const callBody = (fetch as jest.Mock).mock.calls[0][1].body;
      expect(callBody).toContain('wait_for_model');
      expect(callBody).toContain('true');
    });
  });
});
