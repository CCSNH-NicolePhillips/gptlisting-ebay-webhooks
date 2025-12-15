import type { CategoryDef } from "../../src/lib/taxonomy-schema.js";

describe("taxonomy-store", () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  afterEach(() => {
    jest.resetModules();
  });

  describe("configuration", () => {
    it("should throw when Upstash is not configured", async () => {
      jest.resetModules();
      const { putCategory } = await import("../../src/lib/taxonomy-store.js");

      const category: CategoryDef = {
        id: "123",
        slug: "test",
        title: "Test Category",
        marketplaceId: "EBAY_US",
        itemSpecifics: [],
        version: 1,
        updatedAt: Date.now(),
      };

      await expect(putCategory(category)).rejects.toThrow(
        "Upstash Redis not configured"
      );
    });
  });

  describe("putCategory", () => {
    beforeEach(() => {
      process.env.UPSTASH_REDIS_REST_URL = "https://test.upstash.io";
      process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    });

    it("should store category in index, by slug, and by ID", async () => {
      jest.resetModules();
      const { putCategory } = await import("../../src/lib/taxonomy-store.js");

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 1 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: "OK" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: "OK" }),
        });

      const category: CategoryDef = {
        id: "12345",
        slug: "electronics",
        title: "Electronics",
        marketplaceId: "EBAY_US",
        itemSpecifics: [],
        version: 1,
        updatedAt: 1234567890,
      };

      await putCategory(category);

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "https://test.upstash.io/sadd/taxonomy%3Aindex/electronics",
        expect.objectContaining({
          headers: { Authorization: "Bearer test-token" },
        })
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("/set/taxonomy%3Acat%3Aelectronics/"),
        expect.objectContaining({
          headers: { Authorization: "Bearer test-token" },
        })
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining("/set/taxonomy%3Aid%3A12345/"),
        expect.objectContaining({
          headers: { Authorization: "Bearer test-token" },
        })
      );
    });
  });

  describe("getCategory", () => {
    beforeEach(() => {
      process.env.UPSTASH_REDIS_REST_URL = "https://test.upstash.io";
      process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    });

    it("should return null for empty slug", async () => {
      jest.resetModules();
      const { getCategory } = await import("../../src/lib/taxonomy-store.js");

      const result = await getCategory("");
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should return null when category not found", async () => {
      jest.resetModules();
      const { getCategory } = await import("../../src/lib/taxonomy-store.js");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      });

      const result = await getCategory("nonexistent");
      expect(result).toBeNull();
    });

    it("should retrieve category by slug", async () => {
      jest.resetModules();
      const { getCategory } = await import("../../src/lib/taxonomy-store.js");

      const category: CategoryDef = {
        id: "123",
        slug: "test",
        title: "Test",
        marketplaceId: "EBAY_US",
        itemSpecifics: [],
        version: 1,
        updatedAt: 123,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(category) }),
      });

      const result = await getCategory("test");
      expect(result).toEqual(category);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/get/taxonomy%3Acat%3Atest"),
        expect.any(Object)
      );
    });

    it("should return null for malformed JSON", async () => {
      jest.resetModules();
      const { getCategory } = await import("../../src/lib/taxonomy-store.js");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "invalid json{" }),
      });

      const result = await getCategory("test");
      expect(result).toBeNull();
    });
  });

  describe("getCategoryById", () => {
    beforeEach(() => {
      process.env.UPSTASH_REDIS_REST_URL = "https://test.upstash.io";
      process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    });

    it("should return null for empty categoryId", async () => {
      jest.resetModules();
      const { getCategoryById } = await import("../../src/lib/taxonomy-store.js");

      const result = await getCategoryById("");
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should return null when category not found by ID", async () => {
      jest.resetModules();
      const { getCategoryById } = await import("../../src/lib/taxonomy-store.js");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      });

      const result = await getCategoryById("999");
      expect(result).toBeNull();
    });

    it("should retrieve category by ID", async () => {
      jest.resetModules();
      const { getCategoryById } = await import("../../src/lib/taxonomy-store.js");

      const category: CategoryDef = {
        id: "456",
        slug: "electronics",
        title: "Electronics",
        marketplaceId: "EBAY_US",
        itemSpecifics: [],
        version: 1,
        updatedAt: 123,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(category) }),
      });

      const result = await getCategoryById("456");
      expect(result).toEqual(category);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/get/taxonomy%3Aid%3A456"),
        expect.any(Object)
      );
    });

    it("should return null for malformed JSON", async () => {
      jest.resetModules();
      const { getCategoryById } = await import("../../src/lib/taxonomy-store.js");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "not-valid-json{" }),
      });

      const result = await getCategoryById("456");
      expect(result).toBeNull();
    });
  });

  describe("listCategories", () => {
    beforeEach(() => {
      process.env.UPSTASH_REDIS_REST_URL = "https://test.upstash.io";
      process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    });

    it("should return empty array when no categories exist", async () => {
      jest.resetModules();
      const { listCategories } = await import("../../src/lib/taxonomy-store.js");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: [] }),
      });

      const result = await listCategories();
      expect(result).toEqual([]);
    });

    it("should return empty array when index is null", async () => {
      jest.resetModules();
      const { listCategories } = await import("../../src/lib/taxonomy-store.js");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      });

      const result = await listCategories();
      expect(result).toEqual([]);
    });

    it("should fetch all categories from index", async () => {
      jest.resetModules();
      const { listCategories } = await import("../../src/lib/taxonomy-store.js");

      const cat1: CategoryDef = {
        id: "1",
        slug: "cat1",
        title: "Category 1",
        marketplaceId: "EBAY_US",
        itemSpecifics: [],
        version: 1,
        updatedAt: 1000,
      };

      const cat2: CategoryDef = {
        id: "2",
        slug: "cat2",
        title: "Category 2",
        marketplaceId: "EBAY_US",
        itemSpecifics: [],
        version: 1,
        updatedAt: 2000,
      };

      const cat3: CategoryDef = {
        id: "3",
        slug: "cat3",
        title: "Category 3",
        marketplaceId: "EBAY_US",
        itemSpecifics: [],
        version: 1,
        updatedAt: 1500,
      };

      // Index returns slugs
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: ["cat1", "cat2", "cat3"] }),
      });

      // Individual gets
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(cat1) }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(cat2) }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(cat3) }),
      });

      const result = await listCategories();

      // Should be sorted by updatedAt descending
      expect(result).toEqual([cat2, cat3, cat1]);
    });

    it("should handle malformed categories gracefully", async () => {
      jest.resetModules();
      const { listCategories } = await import("../../src/lib/taxonomy-store.js");

      const cat1: CategoryDef = {
        id: "1",
        slug: "cat1",
        title: "Category 1",
        marketplaceId: "EBAY_US",
        itemSpecifics: [],
        version: 1,
        updatedAt: 1000,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: ["cat1", "cat2-bad"] }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(cat1) }),
      });

      // Malformed JSON for cat2
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "invalid{json" }),
      });

      const result = await listCategories();
      expect(result).toEqual([cat1]);
    });

    it("should handle slug mismatch gracefully", async () => {
      jest.resetModules();
      const { listCategories } = await import("../../src/lib/taxonomy-store.js");

      const cat1: CategoryDef = {
        id: "1",
        slug: "cat1",
        title: "Category 1",
        marketplaceId: "EBAY_US",
        itemSpecifics: [],
        version: 1,
        updatedAt: 1000,
      };

      const cat2Mismatch: CategoryDef = {
        id: "2",
        slug: "wrong-slug",
        title: "Category 2",
        marketplaceId: "EBAY_US",
        itemSpecifics: [],
        version: 1,
        updatedAt: 2000,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: ["cat1", "cat2"] }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(cat1) }),
      });

      // Slug mismatch - should be filtered out
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(cat2Mismatch) }),
      });

      const result = await listCategories();
      expect(result).toEqual([cat1]);
    });

    it("should handle null results gracefully", async () => {
      jest.resetModules();
      const { listCategories } = await import("../../src/lib/taxonomy-store.js");

      const cat1: CategoryDef = {
        id: "1",
        slug: "cat1",
        title: "Category 1",
        marketplaceId: "EBAY_US",
        itemSpecifics: [],
        version: 1,
        updatedAt: 1000,
      };

      const cat2: CategoryDef = {
        id: "2",
        slug: "cat2",
        title: "Category 2",
        marketplaceId: "EBAY_US",
        itemSpecifics: [],
        version: 1,
        updatedAt: 0,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: ["cat1", "cat2-missing"] }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(cat1) }),
      });

      // Null result for missing category
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      });

      const result = await listCategories();
      expect(result).toEqual([cat1]);
    });

    it("should batch fetches when there are many categories", async () => {
      jest.resetModules();
      const { listCategories } = await import("../../src/lib/taxonomy-store.js");

      const slugs = Array.from({ length: 150 }, (_, i) => `cat-${i}`);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: slugs }),
      });

      // Mock 150 individual gets
      for (let i = 0; i < 150; i++) {
        const cat: CategoryDef = {
          id: String(i),
          slug: `cat-${i}`,
          title: `Category ${i}`,
          marketplaceId: "EBAY_US",
          itemSpecifics: [],
          version: 1,
          updatedAt: i,
        };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: JSON.stringify(cat) }),
        });
      }

      const result = await listCategories();
      expect(result).toHaveLength(150);
      expect(mockFetch).toHaveBeenCalledTimes(151); // 1 for index + 150 for individual gets
    });
  });

  describe("error handling", () => {
    beforeEach(() => {
      process.env.UPSTASH_REDIS_REST_URL = "https://test.upstash.io";
      process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    });

    it("should throw on fetch error", async () => {
      jest.resetModules();
      const { getCategory } = await import("../../src/lib/taxonomy-store.js");

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      await expect(getCategory("test")).rejects.toThrow("Upstash 500");
    });

    it("should handle fetch text error gracefully", async () => {
      jest.resetModules();
      const { getCategory } = await import("../../src/lib/taxonomy-store.js");

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => {
          throw new Error("Text parsing failed");
        },
      });

      await expect(getCategory("test")).rejects.toThrow("Upstash 503");
    });
  });

  describe("URL encoding", () => {
    beforeEach(() => {
      process.env.UPSTASH_REDIS_REST_URL = "https://test.upstash.io/";
      process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    });

    it("should handle trailing slash in base URL", async () => {
      jest.resetModules();
      const { putCategory } = await import("../../src/lib/taxonomy-store.js");

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 1 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: "OK" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: "OK" }),
        });

      const category: CategoryDef = {
        id: "123",
        slug: "test",
        title: "Test",
        marketplaceId: "EBAY_US",
        itemSpecifics: [],
        version: 1,
        updatedAt: 123,
      };

      await putCategory(category);

      // Should not have double slashes
      expect(mockFetch).toHaveBeenCalledWith(
        expect.not.stringContaining("//sadd"),
        expect.any(Object)
      );
    });

    it("should properly encode special characters in arguments", async () => {
      jest.resetModules();
      const { getCategory } = await import("../../src/lib/taxonomy-store.js");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      });

      await getCategory("test:with:colons");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("test%3Awith%3Acolons"),
        expect.any(Object)
      );
    });
  });
});


