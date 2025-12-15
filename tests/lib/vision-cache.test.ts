// Set environment variables before imports
process.env.UPSTASH_REDIS_REST_URL = "https://test-redis.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token-123";
process.env.VISION_CACHE_TTL_DAYS = "7";

import {
  makeBatchKey,
  getCachedBatch,
  setCachedBatch,
  deleteCachedBatch,
} from "../../src/lib/vision-cache";

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe("vision-cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("makeBatchKey", () => {
    it("should generate consistent hash for same URLs", () => {
      const urls = ["https://example.com/a.jpg", "https://example.com/b.jpg"];
      const key1 = makeBatchKey(urls);
      const key2 = makeBatchKey(urls);

      expect(key1).toBe(key2);
      expect(key1).toMatch(/^visionbatch:[a-f0-9]{40}$/);
    });

    it("should generate same hash regardless of URL order", () => {
      const urls1 = ["https://example.com/a.jpg", "https://example.com/b.jpg"];
      const urls2 = ["https://example.com/b.jpg", "https://example.com/a.jpg"];

      const key1 = makeBatchKey(urls1);
      const key2 = makeBatchKey(urls2);

      expect(key1).toBe(key2);
    });

    it("should generate different hash for different URLs", () => {
      const urls1 = ["https://example.com/a.jpg"];
      const urls2 = ["https://example.com/b.jpg"];

      const key1 = makeBatchKey(urls1);
      const key2 = makeBatchKey(urls2);

      expect(key1).not.toBe(key2);
    });

    it("should trim whitespace from URLs", () => {
      const urls1 = ["https://example.com/a.jpg", "https://example.com/b.jpg"];
      const urls2 = ["  https://example.com/a.jpg  ", "  https://example.com/b.jpg  "];

      const key1 = makeBatchKey(urls1);
      const key2 = makeBatchKey(urls2);

      expect(key1).toBe(key2);
    });

    it("should filter out empty strings", () => {
      const urls1 = ["https://example.com/a.jpg", "", "https://example.com/b.jpg"];
      const urls2 = ["https://example.com/a.jpg", "https://example.com/b.jpg"];

      const key1 = makeBatchKey(urls1);
      const key2 = makeBatchKey(urls2);

      expect(key1).toBe(key2);
    });

    it("should handle empty array", () => {
      const key = makeBatchKey([]);

      expect(key).toMatch(/^visionbatch:[a-f0-9]{40}$/);
    });

    it("should handle non-string values", () => {
      const urls = ["https://example.com/a.jpg", null as any, undefined as any, 123 as any];
      const key = makeBatchKey(urls);

      expect(key).toMatch(/^visionbatch:[a-f0-9]{40}$/);
    });

    it("should handle single URL", () => {
      const key = makeBatchKey(["https://example.com/image.jpg"]);

      expect(key).toMatch(/^visionbatch:[a-f0-9]{40}$/);
    });

    it("should handle many URLs", () => {
      const urls = Array.from({ length: 100 }, (_, i) => `https://example.com/${i}.jpg`);
      const key = makeBatchKey(urls);

      expect(key).toMatch(/^visionbatch:[a-f0-9]{40}$/);
    });

    it("should handle URLs with special characters", () => {
      const urls = [
        "https://example.com/image?param=value&other=test",
        "https://example.com/path/to/image#anchor",
      ];
      const key = makeBatchKey(urls);

      expect(key).toMatch(/^visionbatch:[a-f0-9]{40}$/);
    });
  });

  describe("getCachedBatch", () => {
    it("should retrieve cached data", async () => {
      const urls = ["https://example.com/a.jpg"];
      const cachedData = { results: [{ url: urls[0], text: "test" }] };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(cachedData) }),
      } as any);

      const result = await getCachedBatch(urls);

      expect(result).toEqual(cachedData);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/GET/visionbatch%3A"),
        expect.any(Object)
      );
    });

    it("should return null when cache miss", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      } as any);

      const result = await getCachedBatch(["https://example.com/missing.jpg"]);

      expect(result).toBeNull();
    });

    it("should return null when result is empty string", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "" }),
      } as any);

      const result = await getCachedBatch(["https://example.com/empty.jpg"]);

      expect(result).toBeNull();
    });

    it("should return null when JSON parsing fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "invalid-json{" }),
      } as any);

      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

      const result = await getCachedBatch(["https://example.com/bad.jpg"]);

      expect(result).toBeNull();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "vision-cache parse failed",
        expect.any(Error)
      );

      consoleWarnSpy.mockRestore();
    });

    it("should return null when Redis call fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as any);

      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

      const result = await getCachedBatch(["https://example.com/error.jpg"]);

      expect(result).toBeNull();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "vision-cache redis call failed",
        expect.any(Error)
      );

      consoleWarnSpy.mockRestore();
    });

    it("should return null when Redis not configured", async () => {
      const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
      const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;

      jest.resetModules();
      const { getCachedBatch: getCachedBatchNew } = await import(
        "../../src/lib/vision-cache"
      );

      const result = await getCachedBatchNew(["https://example.com/test.jpg"]);

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();

      process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      jest.resetModules();
    });

    it("should handle complex cached data structures", async () => {
      const urls = ["https://example.com/a.jpg", "https://example.com/b.jpg"];
      const cachedData = {
        results: [
          { url: urls[0], text: "test1", confidence: 0.95 },
          { url: urls[1], text: "test2", confidence: 0.87 },
        ],
        metadata: { timestamp: 12345, version: "1.0" },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(cachedData) }),
      } as any);

      const result = await getCachedBatch(urls);

      expect(result).toEqual(cachedData);
    });

    it("should include authorization header", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      } as any);

      await getCachedBatch(["https://example.com/test.jpg"]);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: "POST",
          headers: { Authorization: "Bearer test-token-123" },
        })
      );
    });
  });

  describe("setCachedBatch", () => {
    it("should cache data with TTL", async () => {
      const urls = ["https://example.com/a.jpg"];
      const data = { results: [{ url: urls[0], text: "cached" }] };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      } as any);

      await setCachedBatch(urls, data);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/SET/visionbatch%3A"),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/EXPIRE/visionbatch%3A"),
        expect.any(Object)
      );
    });

    it("should use correct TTL in seconds (7 days default)", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      } as any);

      await setCachedBatch(["https://example.com/test.jpg"], { data: "test" });

      const expectedTTL = 7 * 24 * 60 * 60; // 604800 seconds
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/${expectedTTL}`),
        expect.any(Object)
      );
    });

    it("should serialize data to JSON", async () => {
      const data = { complex: { nested: { structure: [1, 2, 3] } } };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      } as any);

      await setCachedBatch(["https://example.com/test.jpg"], data);

      const setCall = mockFetch.mock.calls.find((call) =>
        (call[0] as string).includes("/SET/")
      );
      expect(setCall).toBeDefined();
      expect(setCall![0]).toContain(encodeURIComponent(JSON.stringify(data)));
    });

    it("should handle null data", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      } as any);

      await setCachedBatch(["https://example.com/test.jpg"], null);

      expect(mockFetch).toHaveBeenCalled();
    });

    it("should handle Redis errors silently", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      } as any);

      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

      await setCachedBatch(["https://example.com/test.jpg"], { data: "test" });

      expect(consoleWarnSpy).toHaveBeenCalled();
      consoleWarnSpy.mockRestore();
    });

    it("should not call Redis when not configured", async () => {
      const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
      const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;

      jest.resetModules();
      const { setCachedBatch: setCachedBatchNew } = await import(
        "../../src/lib/vision-cache"
      );

      await setCachedBatchNew(["https://example.com/test.jpg"], { data: "test" });

      expect(mockFetch).not.toHaveBeenCalled();

      process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      jest.resetModules();
    });

    it("should use custom TTL from environment variable", async () => {
      process.env.VISION_CACHE_TTL_DAYS = "14";

      jest.resetModules();
      const { setCachedBatch: setCachedBatchNew } = await import(
        "../../src/lib/vision-cache"
      );

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      } as any);

      await setCachedBatchNew(["https://example.com/test.jpg"], { data: "test" });

      const expectedTTL = 14 * 24 * 60 * 60; // 14 days in seconds
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/${expectedTTL}`),
        expect.any(Object)
      );

      process.env.VISION_CACHE_TTL_DAYS = "7";
      jest.resetModules();
    });

    it("should default to 7 days when TTL is invalid", async () => {
      process.env.VISION_CACHE_TTL_DAYS = "invalid";

      jest.resetModules();
      const { setCachedBatch: setCachedBatchNew } = await import(
        "../../src/lib/vision-cache"
      );

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      } as any);

      await setCachedBatchNew(["https://example.com/test.jpg"], { data: "test" });

      const expectedTTL = 7 * 24 * 60 * 60;
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/${expectedTTL}`),
        expect.any(Object)
      );

      process.env.VISION_CACHE_TTL_DAYS = "7";
      jest.resetModules();
    });

    it("should default to 7 days when TTL is negative", async () => {
      process.env.VISION_CACHE_TTL_DAYS = "-5";

      jest.resetModules();
      const { setCachedBatch: setCachedBatchNew } = await import(
        "../../src/lib/vision-cache"
      );

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      } as any);

      await setCachedBatchNew(["https://example.com/test.jpg"], { data: "test" });

      const expectedTTL = 7 * 24 * 60 * 60;
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/${expectedTTL}`),
        expect.any(Object)
      );

      process.env.VISION_CACHE_TTL_DAYS = "7";
      jest.resetModules();
    });
  });

  describe("deleteCachedBatch", () => {
    it("should delete cache entry", async () => {
      const urls = ["https://example.com/a.jpg"];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 1 }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: null }),
        } as any);

      const consoleLogSpy = jest.spyOn(console, "log").mockImplementation();

      await deleteCachedBatch(urls);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/DEL/visionbatch%3A"),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/GET/visionbatch%3A"),
        expect.any(Object)
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("✅ Confirmed cache key")
      );

      consoleLogSpy.mockRestore();
    });

    it("should log when deletion fails", async () => {
      const urls = ["https://example.com/a.jpg"];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 0 }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: null }),
        } as any);

      const consoleLogSpy = jest.spyOn(console, "log").mockImplementation();

      await deleteCachedBatch(urls);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("DELETE result: 0 key(s) removed")
      );

      consoleLogSpy.mockRestore();
    });

    it("should warn if key still exists after deletion", async () => {
      const urls = ["https://example.com/a.jpg"];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 1 }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: "still-here" }),
        } as any);

      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();
      const consoleLogSpy = jest.spyOn(console, "log").mockImplementation();

      await deleteCachedBatch(urls);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("⚠️ Cache key")
      );

      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    it("should log URLs being deleted", async () => {
      const urls = [
        "https://example.com/path/image1.jpg",
        "https://example.com/path/image2.jpg",
        "https://example.com/path/image3.jpg",
      ];

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: null }),
      } as any);

      const consoleLogSpy = jest.spyOn(console, "log").mockImplementation();

      await deleteCachedBatch(urls);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("URLs being deleted:"),
        expect.any(Array)
      );

      consoleLogSpy.mockRestore();
    });

    it("should handle Redis errors", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      } as any);

      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();
      const consoleLogSpy = jest.spyOn(console, "log").mockImplementation();

      await deleteCachedBatch(["https://example.com/test.jpg"]);

      expect(consoleWarnSpy).toHaveBeenCalled();
      consoleLogSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });

    it("should not call Redis when not configured", async () => {
      const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
      const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;

      jest.resetModules();
      const { deleteCachedBatch: deleteCachedBatchNew } = await import(
        "../../src/lib/vision-cache"
      );

      const consoleLogSpy = jest.spyOn(console, "log").mockImplementation();

      await deleteCachedBatchNew(["https://example.com/test.jpg"]);

      expect(mockFetch).not.toHaveBeenCalled();

      consoleLogSpy.mockRestore();
      process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      jest.resetModules();
    });
  });
});
