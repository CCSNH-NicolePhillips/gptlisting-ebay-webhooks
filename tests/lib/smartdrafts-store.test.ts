import type { ImageInsight } from "../../src/lib/image-insight.js";

// Store original env vars
const originalEnv = { ...process.env };

// Mock fetch before imports
let mockFetch: jest.Mock;

describe("smartdrafts-store", () => {
  beforeEach(() => {
    jest.resetModules();
    mockFetch = jest.fn();
    global.fetch = mockFetch;
    
    // Set up environment
    process.env.UPSTASH_REDIS_REST_URL = "https://test-redis.upstash.io/";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    process.env.SMARTDRAFT_CACHE_TTL_DAYS = "2";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  describe("environment validation", () => {
    it("should warn when Upstash credentials are missing", async () => {
      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();
      
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      
      jest.resetModules();
      await import("../../src/lib/smartdrafts-store.js");
      
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("SmartDraft cache disabled")
      );
      
      consoleWarnSpy.mockRestore();
    });

    it("should handle missing SMARTDRAFT_CACHE_TTL_DAYS with default", async () => {
      delete process.env.SMARTDRAFT_CACHE_TTL_DAYS;
      
      jest.resetModules();
      const { setCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      });
      
      const payload = {
        signature: "test",
        groups: [],
        updatedAt: Date.now(),
      };
      
      await setCachedSmartDraftGroups("test-key", payload);
      
      // Should use default TTL of 2 days = 172800 seconds
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/EXPIRE/test-key/172800"),
        expect.anything()
      );
    });

    it("should handle invalid SMARTDRAFT_CACHE_TTL_DAYS", async () => {
      process.env.SMARTDRAFT_CACHE_TTL_DAYS = "invalid";
      
      jest.resetModules();
      const { setCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      });
      
      const payload = {
        signature: "test",
        groups: [],
        updatedAt: Date.now(),
      };
      
      await setCachedSmartDraftGroups("test-key", payload);
      
      // Should use default TTL of 2 days
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/EXPIRE/test-key/172800"),
        expect.anything()
      );
    });

    it("should handle negative SMARTDRAFT_CACHE_TTL_DAYS", async () => {
      process.env.SMARTDRAFT_CACHE_TTL_DAYS = "-5";
      
      jest.resetModules();
      const { setCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      });
      
      const payload = {
        signature: "test",
        groups: [],
        updatedAt: Date.now(),
      };
      
      await setCachedSmartDraftGroups("test-key", payload);
      
      // Should use default TTL of 2 days
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/EXPIRE/test-key/172800"),
        expect.anything()
      );
    });

    it("should use custom SMARTDRAFT_CACHE_TTL_DAYS when valid", async () => {
      process.env.SMARTDRAFT_CACHE_TTL_DAYS = "7";
      
      jest.resetModules();
      const { setCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      });
      
      const payload = {
        signature: "test",
        groups: [],
        updatedAt: Date.now(),
      };
      
      await setCachedSmartDraftGroups("test-key", payload);
      
      // Should use 7 days = 604800 seconds
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/EXPIRE/test-key/604800"),
        expect.anything()
      );
    });
  });

  describe("makeCacheKey", () => {
    it("should generate consistent hash for same inputs", async () => {
      const { makeCacheKey } = await import("../../src/lib/smartdrafts-store.js");
      
      const key1 = makeCacheKey("user123", "MyFolder");
      const key2 = makeCacheKey("user123", "MyFolder");
      
      expect(key1).toBe(key2);
      expect(key1).toMatch(/^smartdrafts:[a-f0-9]{40}$/);
    });

    it("should normalize folder names", async () => {
      const { makeCacheKey } = await import("../../src/lib/smartdrafts-store.js");
      
      const key1 = makeCacheKey("user123", "MyFolder");
      const key2 = makeCacheKey("user123", "myfolder");
      const key3 = makeCacheKey("user123", "  MyFolder  ");
      
      expect(key1).toBe(key2);
      expect(key1).toBe(key3);
    });

    it("should generate different hashes for different users", async () => {
      const { makeCacheKey } = await import("../../src/lib/smartdrafts-store.js");
      
      const key1 = makeCacheKey("user123", "folder");
      const key2 = makeCacheKey("user456", "folder");
      
      expect(key1).not.toBe(key2);
    });

    it("should generate different hashes for different folders", async () => {
      const { makeCacheKey } = await import("../../src/lib/smartdrafts-store.js");
      
      const key1 = makeCacheKey("user123", "folder1");
      const key2 = makeCacheKey("user123", "folder2");
      
      expect(key1).not.toBe(key2);
    });

    it("should default empty folder to root", async () => {
      const { makeCacheKey } = await import("../../src/lib/smartdrafts-store.js");
      
      const key1 = makeCacheKey("user123", "");
      const key2 = makeCacheKey("user123", "/");
      
      expect(key1).toBe(key2);
    });
  });

  describe("getCachedSmartDraftGroups", () => {
    it("should retrieve and parse valid cached data", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      const cached = {
        signature: "test-signature",
        groups: [{ id: 1 }],
        orphans: [{ id: 2 }],
        warnings: ["warning1"],
        links: { key1: "value1" },
        imageInsights: {
          "https://example.com/image.jpg": { description: "Test image" },
        },
        updatedAt: 1234567890,
      };
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(cached) }),
      });
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      expect(result).toEqual({
        signature: "test-signature",
        groups: [{ id: 1 }],
        orphans: [{ id: 2 }],
        warnings: ["warning1"],
        links: { key1: "value1" },
        imageInsights: {
          "https://example.com/image.jpg": {
            description: "Test image",
            url: "https://example.com/image.jpg",
          },
        },
        updatedAt: 1234567890,
      });
    });

    it("should return null when no cached data exists", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      });
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      expect(result).toBeNull();
    });

    it("should return null when credentials are missing", async () => {
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      
      jest.resetModules();
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should return null for non-string result", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 12345 }),
      });
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      expect(result).toBeNull();
    });

    it("should return null for empty string result", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "" }),
      });
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      expect(result).toBeNull();
    });

    it("should return null for invalid JSON", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "invalid json {" }),
      });
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      expect(result).toBeNull();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "smartdrafts cache parse failed",
        expect.any(Error)
      );
      
      consoleWarnSpy.mockRestore();
    });

    it("should return null when parsed data is not an object", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify("string value") }),
      });
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      expect(result).toBeNull();
    });

    it("should return null when signature is missing", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify({ groups: [] }) }),
      });
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      expect(result).toBeNull();
    });

    it("should return null when signature is empty string", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify({ signature: "", groups: [] }) }),
      });
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      expect(result).toBeNull();
    });

    it("should default groups to empty array when not array", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: JSON.stringify({ signature: "test", groups: "not-array" }),
        }),
      });
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      expect(result?.groups).toEqual([]);
    });

    it("should set orphans to undefined when not array", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: JSON.stringify({ signature: "test", groups: [], orphans: "not-array" }),
        }),
      });
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      expect(result?.orphans).toBeUndefined();
    });

    it("should set warnings to undefined when not array", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: JSON.stringify({ signature: "test", groups: [], warnings: "not-array" }),
        }),
      });
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      expect(result?.warnings).toBeUndefined();
    });

    it("should filter invalid links entries", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: JSON.stringify({
            signature: "test",
            groups: [],
            links: {
              valid: "value",
              empty: "",
              notString: 123,
              emptyKey: "value",
            },
          }),
        }),
      });
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      // Should filter out empty strings and non-strings
      expect(result?.links).toEqual({ valid: "value", emptyKey: "value" });
    });

    it("should set links to undefined when not object", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: JSON.stringify({ signature: "test", groups: [], links: "not-object" }),
        }),
      });
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      expect(result?.links).toBeUndefined();
    });

    it("should filter invalid imageInsights entries", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: JSON.stringify({
            signature: "test",
            groups: [],
            imageInsights: {
              "https://valid.com/img.jpg": { description: "Valid" },
              notString: { description: "Valid object" },
              "https://null.com/img.jpg": null,
              "https://string.com/img.jpg": "not-object",
            },
          }),
        }),
      });
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      // Should filter out null and non-object values
      expect(result?.imageInsights).toEqual({
        "https://valid.com/img.jpg": {
          description: "Valid",
          url: "https://valid.com/img.jpg",
        },
        notString: {
          description: "Valid object",
          url: "notString",
        },
      });
    });

    it("should set imageInsights to undefined when not object", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: JSON.stringify({ signature: "test", groups: [], imageInsights: "not-object" }),
        }),
      });
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      expect(result?.imageInsights).toBeUndefined();
    });

    it("should default updatedAt to Date.now when missing", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now);
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: JSON.stringify({ signature: "test", groups: [] }),
        }),
      });
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      expect(result?.updatedAt).toBe(now);
    });

    it("should handle fetch errors gracefully", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      expect(result).toBeNull();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "smartdrafts-store redis call failed",
        expect.any(Error)
      );
      
      consoleWarnSpy.mockRestore();
    });

    it("should handle network errors gracefully", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();
      
      mockFetch.mockRejectedValueOnce(new Error("Network error"));
      
      const result = await getCachedSmartDraftGroups("test-key");
      
      expect(result).toBeNull();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "smartdrafts-store redis call failed",
        expect.any(Error)
      );
      
      consoleWarnSpy.mockRestore();
    });

    it("should encode special characters in key", async () => {
      const { getCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      });
      
      await getCachedSmartDraftGroups("test/key&special");
      
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("test%2Fkey%26special"),
        expect.anything()
      );
    });
  });

  describe("setCachedSmartDraftGroups", () => {
    it("should store complete payload with TTL", async () => {
      const { setCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      });
      
      const payload = {
        signature: "test-signature",
        groups: [{ id: 1 }],
        orphans: [{ id: 2 }],
        warnings: ["warning1"],
        links: { key: "value" },
        imageInsights: {
          "https://example.com/img.jpg": { description: "Test" } as unknown as ImageInsight,
        },
        updatedAt: 1234567890,
      };
      
      await setCachedSmartDraftGroups("test-key", payload);
      
      expect(mockFetch).toHaveBeenCalledTimes(2);
      
      // First call: SET
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining("/SET/test-key/"),
        expect.objectContaining({
          method: "POST",
          headers: { Authorization: "Bearer test-token" },
        })
      );
      
      // Second call: EXPIRE with 2 days = 172800 seconds
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("/EXPIRE/test-key/172800"),
        expect.anything()
      );
    });

    it("should sanitize non-array groups to empty array", async () => {
      const { setCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      });
      
      const payload = {
        signature: "test",
        groups: "not-array" as any,
        updatedAt: 123,
      };
      
      await setCachedSmartDraftGroups("test-key", payload);
      
      const setCallUrl = mockFetch.mock.calls[0][0];
      const encodedPayload = setCallUrl.split("/SET/test-key/")[1];
      const decodedPayload = JSON.parse(decodeURIComponent(encodedPayload));
      
      expect(decodedPayload.groups).toEqual([]);
    });

    it("should sanitize non-array orphans to undefined", async () => {
      const { setCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      });
      
      const payload = {
        signature: "test",
        groups: [],
        orphans: "not-array" as any,
        updatedAt: 123,
      };
      
      await setCachedSmartDraftGroups("test-key", payload);
      
      const setCallUrl = mockFetch.mock.calls[0][0];
      const encodedPayload = setCallUrl.split("/SET/test-key/")[1];
      const decodedPayload = JSON.parse(decodeURIComponent(encodedPayload));
      
      expect(decodedPayload.orphans).toBeUndefined();
    });

    it("should sanitize non-array warnings to undefined", async () => {
      const { setCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      });
      
      const payload = {
        signature: "test",
        groups: [],
        warnings: "not-array" as any,
        updatedAt: 123,
      };
      
      await setCachedSmartDraftGroups("test-key", payload);
      
      const setCallUrl = mockFetch.mock.calls[0][0];
      const encodedPayload = setCallUrl.split("/SET/test-key/")[1];
      const decodedPayload = JSON.parse(decodeURIComponent(encodedPayload));
      
      expect(decodedPayload.warnings).toBeUndefined();
    });

    it("should sanitize non-object links to undefined", async () => {
      const { setCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      });
      
      const payload = {
        signature: "test",
        groups: [],
        links: "not-object" as any,
        updatedAt: 123,
      };
      
      await setCachedSmartDraftGroups("test-key", payload);
      
      const setCallUrl = mockFetch.mock.calls[0][0];
      const encodedPayload = setCallUrl.split("/SET/test-key/")[1];
      const decodedPayload = JSON.parse(decodeURIComponent(encodedPayload));
      
      expect(decodedPayload.links).toBeUndefined();
    });

    it("should sanitize non-object imageInsights to undefined", async () => {
      const { setCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      });
      
      const payload = {
        signature: "test",
        groups: [],
        imageInsights: "not-object" as any,
        updatedAt: 123,
      };
      
      await setCachedSmartDraftGroups("test-key", payload);
      
      const setCallUrl = mockFetch.mock.calls[0][0];
      const encodedPayload = setCallUrl.split("/SET/test-key/")[1];
      const decodedPayload = JSON.parse(decodeURIComponent(encodedPayload));
      
      expect(decodedPayload.imageInsights).toBeUndefined();
    });

    it("should default updatedAt to Date.now when missing", async () => {
      const { setCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now);
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      });
      
      const payload = {
        signature: "test",
        groups: [],
        updatedAt: 0,
      };
      
      await setCachedSmartDraftGroups("test-key", payload);
      
      const setCallUrl = mockFetch.mock.calls[0][0];
      const encodedPayload = setCallUrl.split("/SET/test-key/")[1];
      const decodedPayload = JSON.parse(decodeURIComponent(encodedPayload));
      
      expect(decodedPayload.updatedAt).toBe(now);
    });

    it("should handle trailing slash in UPSTASH_REDIS_REST_URL", async () => {
      process.env.UPSTASH_REDIS_REST_URL = "https://test-redis.upstash.io/";
      
      jest.resetModules();
      const { setCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      });
      
      const payload = {
        signature: "test",
        groups: [],
        updatedAt: 123,
      };
      
      await setCachedSmartDraftGroups("test-key", payload);
      
      // Should not have double slashes
      expect(mockFetch).toHaveBeenCalledWith(
        expect.not.stringContaining("//SET"),
        expect.anything()
      );
    });

    it("should not call Redis when credentials are missing", async () => {
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      
      jest.resetModules();
      const { setCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      const payload = {
        signature: "test",
        groups: [],
        updatedAt: 123,
      };
      
      await setCachedSmartDraftGroups("test-key", payload);
      
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should encode special characters in key", async () => {
      const { setCachedSmartDraftGroups } = await import("../../src/lib/smartdrafts-store.js");
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      });
      
      const payload = {
        signature: "test",
        groups: [],
        updatedAt: 123,
      };
      
      await setCachedSmartDraftGroups("test/key&special", payload);
      
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("test%2Fkey%26special"),
        expect.anything()
      );
    });
  });
});
