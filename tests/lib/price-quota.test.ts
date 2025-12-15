// Set environment variables before imports
process.env.UPSTASH_REDIS_REST_URL = "https://test-redis.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token-123";
process.env.PRICE_QUOTA_SERPAPI = "200";
process.env.PRICE_QUOTA_BRAVE = "2000";
process.env.SERPAPI_KEY = "test-serpapi-key";
process.env.BRAVE_API_KEY = "test-brave-key";

import {
  canUseSerp,
  incSerp,
  canUseBrave,
  incBrave,
} from "../../src/lib/price-quota";

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe("price-quota", () => {
  let originalDate: typeof Date;

  beforeAll(() => {
    originalDate = global.Date;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock Date to return consistent values
    const mockDate = new Date("2025-03-15T12:00:00Z");
    global.Date = class extends originalDate {
      constructor() {
        super();
        return mockDate;
      }
      static now() {
        return mockDate.getTime();
      }
    } as any;
  });

  afterEach(() => {
    global.Date = originalDate;
  });

  describe("canUseSerp", () => {
    it("should return true when under quota limit", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "50" }),
      } as any);

      const result = await canUseSerp();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://test-redis.upstash.io/GET/pricequota%3Aserpapi%3A2025-03",
        expect.any(Object)
      );
    });

    it("should return false when at quota limit", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "200" }),
      } as any);

      const result = await canUseSerp();

      expect(result).toBe(false);
    });

    it("should return false when over quota limit", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "250" }),
      } as any);

      const result = await canUseSerp();

      expect(result).toBe(false);
    });

    it("should return true when count is 0", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "0" }),
      } as any);

      const result = await canUseSerp();

      expect(result).toBe(true);
    });

    it("should handle null Redis result", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      } as any);

      const result = await canUseSerp();

      expect(result).toBe(true); // Treats null as 0
    });

    it("should handle Redis errors gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as any);

      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

      const result = await canUseSerp();

      expect(result).toBe(true); // Defaults to 0 on error
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "price-quota read failed",
        expect.any(Error)
      );

      consoleWarnSpy.mockRestore();
    });

    it("should fallback to API key check when Redis not configured", async () => {
      const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
      const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;

      jest.resetModules();
      const { canUseSerp: canUseSerpNew } = await import("../../src/lib/price-quota");

      const result = await canUseSerpNew();

      expect(result).toBe(true); // Has SERPAPI_KEY
      expect(mockFetch).not.toHaveBeenCalled();

      process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      jest.resetModules();
    });

    it("should return false when Redis not configured and no API key", async () => {
      const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
      const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      const originalApiKey = process.env.SERPAPI_KEY;
      
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.SERPAPI_KEY;

      jest.resetModules();
      const { canUseSerp: canUseSerpNew } = await import("../../src/lib/price-quota");

      const result = await canUseSerpNew();

      expect(result).toBe(false);

      process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      process.env.SERPAPI_KEY = originalApiKey;
      jest.resetModules();
    });

    it("should fallback to API key check when limit is not finite", async () => {
      process.env.PRICE_QUOTA_SERPAPI = "NaN";

      jest.resetModules();
      const { canUseSerp: canUseSerpNew } = await import("../../src/lib/price-quota");

      const result = await canUseSerpNew();

      expect(result).toBe(true); // Has SERPAPI_KEY
      expect(mockFetch).not.toHaveBeenCalled();

      process.env.PRICE_QUOTA_SERPAPI = "200";
      jest.resetModules();
    });

    it("should fallback to API key check when limit is 0", async () => {
      process.env.PRICE_QUOTA_SERPAPI = "0";

      jest.resetModules();
      const { canUseSerp: canUseSerpNew } = await import("../../src/lib/price-quota");

      const result = await canUseSerpNew();

      expect(result).toBe(true); // Has SERPAPI_KEY

      process.env.PRICE_QUOTA_SERPAPI = "200";
      jest.resetModules();
    });

    it("should fallback to API key check when limit is negative", async () => {
      process.env.PRICE_QUOTA_SERPAPI = "-100";

      jest.resetModules();
      const { canUseSerp: canUseSerpNew } = await import("../../src/lib/price-quota");

      const result = await canUseSerpNew();

      expect(result).toBe(true); // Has SERPAPI_KEY

      process.env.PRICE_QUOTA_SERPAPI = "200";
      jest.resetModules();
    });
  });

  describe("incSerp", () => {
    it("should increment counter and set expiry", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: 1 }),
      } as any);

      await incSerp();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://test-redis.upstash.io/INCR/pricequota%3Aserpapi%3A2025-03",
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("EXPIRE/pricequota%3Aserpapi%3A2025-03/3456000"),
        expect.any(Object)
      );
    });

    it("should handle Redis errors gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as any);

      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

      await incSerp(); // Should not throw

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "price-quota write failed",
        expect.any(Error)
      );

      consoleWarnSpy.mockRestore();
    });

    it("should not call Redis when not configured", async () => {
      const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
      const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;

      jest.resetModules();
      const { incSerp: incSerpNew } = await import("../../src/lib/price-quota");

      await incSerpNew();

      expect(mockFetch).not.toHaveBeenCalled();

      process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      jest.resetModules();
    });

    it("should set expiry to 40 days", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: 1 }),
      } as any);

      await incSerp();

      // 40 days * 24 hours * 60 minutes * 60 seconds = 3456000
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/3456000"),
        expect.any(Object)
      );
    });
  });

  describe("canUseBrave", () => {
    it("should return true when under quota limit", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "500" }),
      } as any);

      const result = await canUseBrave();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://test-redis.upstash.io/GET/pricequota%3Abrave%3A2025-03",
        expect.any(Object)
      );
    });

    it("should return false when at quota limit", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "2000" }),
      } as any);

      const result = await canUseBrave();

      expect(result).toBe(false);
    });

    it("should return false when over quota limit", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "2500" }),
      } as any);

      const result = await canUseBrave();

      expect(result).toBe(false);
    });

    it("should return true when count is 0", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "0" }),
      } as any);

      const result = await canUseBrave();

      expect(result).toBe(true);
    });

    it("should handle null Redis result", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      } as any);

      const result = await canUseBrave();

      expect(result).toBe(true);
    });

    it("should handle Redis errors gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as any);

      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

      const result = await canUseBrave();

      expect(result).toBe(true);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "price-quota read failed",
        expect.any(Error)
      );

      consoleWarnSpy.mockRestore();
    });

    it("should fallback to API key check when Redis not configured", async () => {
      const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
      const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;

      jest.resetModules();
      const { canUseBrave: canUseBraveNew } = await import("../../src/lib/price-quota");

      const result = await canUseBraveNew();

      expect(result).toBe(true); // Has BRAVE_API_KEY
      expect(mockFetch).not.toHaveBeenCalled();

      process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      jest.resetModules();
    });

    it("should fallback to API key check when limit is invalid", async () => {
      process.env.PRICE_QUOTA_BRAVE = "invalid";

      jest.resetModules();
      const { canUseBrave: canUseBraveNew } = await import("../../src/lib/price-quota");

      const result = await canUseBraveNew();

      expect(result).toBe(true); // Has BRAVE_API_KEY

      process.env.PRICE_QUOTA_BRAVE = "2000";
      jest.resetModules();
    });
  });

  describe("incBrave", () => {
    it("should increment counter and set expiry", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: 1 }),
      } as any);

      await incBrave();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://test-redis.upstash.io/INCR/pricequota%3Abrave%3A2025-03",
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("EXPIRE/pricequota%3Abrave%3A2025-03/3456000"),
        expect.any(Object)
      );
    });

    it("should handle Redis errors gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as any);

      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

      await incBrave(); // Should not throw

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "price-quota write failed",
        expect.any(Error)
      );

      consoleWarnSpy.mockRestore();
    });

    it("should not call Redis when not configured", async () => {
      const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
      const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;

      jest.resetModules();
      const { incBrave: incBraveNew } = await import("../../src/lib/price-quota");

      await incBraveNew();

      expect(mockFetch).not.toHaveBeenCalled();

      process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      jest.resetModules();
    });
  });

  describe("authorization headers", () => {
    it("should include Bearer token in requests", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "0" }),
      } as any);

      await canUseSerp();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: "POST",
          headers: { Authorization: "Bearer test-token-123" },
        })
      );
    });
  });
});
