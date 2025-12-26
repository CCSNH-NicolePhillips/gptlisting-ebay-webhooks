import type { TaxonomyMappedDraft } from "../../src/lib/taxonomy-map.js";

// Mock dependencies
jest.mock("../../src/lib/taxonomy-map.js");
jest.mock("../../src/lib/image-utils.js");

describe("map-group-to-draft", () => {
  let mockFetch: jest.Mock;
  let mapGroupToDraftWithTaxonomy: jest.Mock;
  let proxyImageUrls: jest.Mock;

  const baseDraft: TaxonomyMappedDraft = {
    sku: "BASE-SKU-123",
    inventory: {
      condition: "NEW",
      product: {
        title: "Base Product Title",
        description: "Base description",
        imageUrls: ["https://example.com/image1.jpg"],
        aspects: {
          Brand: ["BaseBrand"],
          Color: ["Blue"],
        },
      },
    },
    offer: {
      sku: "BASE-SKU-123",
      marketplaceId: "EBAY_US",
      categoryId: "12345",
      price: 99.99,
      quantity: 1,
      condition: 1000,
      fulfillmentPolicyId: "fp1",
      paymentPolicyId: "pp1",
      returnPolicyId: "rp1",
      merchantLocationKey: "loc1",
      description: "Offer description",
    },
    _meta: {
      marketplaceId: "EBAY_US",
      categoryId: "12345",
      price: 99.99,
      selectedCategory: {
        id: "12345",
        slug: "electronics",
        title: "Electronics",
      },
      missingRequired: [],
    },
  };

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;

    const taxonomyMap = jest.requireMock("../../src/lib/taxonomy-map.js");
    mapGroupToDraftWithTaxonomy = jest.fn().mockResolvedValue(JSON.parse(JSON.stringify(baseDraft)));
    taxonomyMap.mapGroupToDraftWithTaxonomy = mapGroupToDraftWithTaxonomy;

    const imageUtils = jest.requireMock("../../src/lib/image-utils.js");
    proxyImageUrls = jest.fn((urls: string[]) => urls.map(url => `proxied:${url}`));
    imageUtils.proxyImageUrls = proxyImageUrls;

    process.env.UPSTASH_REDIS_REST_URL = "https://test.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    process.env.APP_URL = "https://app.example.com";

    // Suppress console.log during tests
    jest.spyOn(console, "log").mockImplementation();
    jest.spyOn(console, "warn").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.APP_URL;
  });

  describe("basic mapping without overrides", () => {
    it("should map group to draft using taxonomy", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const group = {
        groupId: "g123",
        brand: "TestBrand",
        product: "Test Product",
      };

      const result = await mapGroupToDraft(group);

      expect(mapGroupToDraftWithTaxonomy).toHaveBeenCalledWith(group, undefined);
      expect(result.sku).toBe("BASE-SKU-123");
      expect(result.inventory.product.title).toBe("Base Product Title");
    });

    it("should return base draft when no options provided", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group);

      expect(result).toEqual(expect.objectContaining({
        sku: "BASE-SKU-123",
      }));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should return base draft when options is empty string", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, "");

      expect(result.sku).toBe("BASE-SKU-123");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should handle group with id instead of groupId", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const group = { id: "g456", brand: "TestBrand" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(mapGroupToDraftWithTaxonomy).toHaveBeenCalledWith(group, "u1");
    });

    it("should handle missing groupId gracefully", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const group = { brand: "TestBrand" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.sku).toBe("BASE-SKU-123");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("image proxying", () => {
    it("should proxy image URLs through image-proxy", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group);

      expect(proxyImageUrls).toHaveBeenCalledWith(
        ["https://example.com/image1.jpg"],
        "https://app.example.com"
      );
      expect(result.inventory.product.imageUrls).toEqual([
        "proxied:https://example.com/image1.jpg",
      ]);
    });

    it("should handle multiple image URLs", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      mapGroupToDraftWithTaxonomy.mockResolvedValueOnce({
        ...baseDraft,
        inventory: {
          ...baseDraft.inventory,
          product: {
            ...baseDraft.inventory.product,
            imageUrls: ["url1.jpg", "url2.jpg", "url3.jpg"],
          },
        },
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group);

      expect(proxyImageUrls).toHaveBeenCalledWith(
        ["url1.jpg", "url2.jpg", "url3.jpg"],
        "https://app.example.com"
      );
    });

    it("should handle empty image array", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      mapGroupToDraftWithTaxonomy.mockResolvedValueOnce({
        ...baseDraft,
        inventory: {
          ...baseDraft.inventory,
          product: {
            ...baseDraft.inventory.product,
            imageUrls: [],
          },
        },
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group);

      expect(proxyImageUrls).not.toHaveBeenCalled();
      expect(result.inventory.product.imageUrls).toEqual([]);
    });

    it("should use fallback APP_URL from environment", async () => {
      delete process.env.APP_URL;
      process.env.URL = "https://fallback.com";

      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const group = { groupId: "g123" };
      await mapGroupToDraft(group);

      expect(proxyImageUrls).toHaveBeenCalledWith(
        expect.any(Array),
        "https://fallback.com"
      );
    });
  });

  describe("override fetching", () => {
    it("should fetch override from Redis when options provided", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        sku: "OVERRIDE-SKU",
        inventory: {
          product: {
            title: "Override Title",
          },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("taxo%3Aovr%3Au1%3Aj1%3Ag123"),
        expect.objectContaining({
          method: "POST",
          headers: { Authorization: "Bearer test-token" },
        })
      );
      expect(result.sku).toBe("OVERRIDE-SKU");
      expect(result.inventory.product.title).toBe("Override Title");
    });

    it("should handle jobId as string option", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      });

      const group = { groupId: "g123" };
      await mapGroupToDraft(group, "job-abc");

      // Should not fetch override without userId
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should return base draft when override not found", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.sku).toBe("BASE-SKU-123");
    });

    it("should handle Redis fetch error gracefully", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(console.warn).toHaveBeenCalledWith(
        "[map-group-to-draft] failed to load override",
        expect.any(Error)
      );
      expect(result.sku).toBe("BASE-SKU-123");
    });

    it("should handle malformed override JSON", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "invalid{json" }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.sku).toBe("BASE-SKU-123");
    });

    it("should not fetch override without Upstash config", async () => {
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;

      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.sku).toBe("BASE-SKU-123");
    });
  });

  describe("override application - SKU", () => {
    it("should override SKU", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = { sku: "NEW-SKU-456" };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.sku).toBe("NEW-SKU-456");
      expect(result.offer.sku).toBe("NEW-SKU-456");
    });

    it("should trim whitespace from SKU override", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = { sku: "  TRIMMED-SKU  " };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.sku).toBe("TRIMMED-SKU");
      expect(result.offer.sku).toBe("TRIMMED-SKU");
    });

    it("should ignore empty SKU override", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = { sku: "   " };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.sku).toBe("BASE-SKU-123");
    });

    it("should ignore non-string SKU", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = { sku: 12345 as any };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.sku).toBe("BASE-SKU-123");
    });
  });

  describe("override application - inventory", () => {
    it("should override inventory condition", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        inventory: {
          condition: "USED_EXCELLENT",
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.inventory.condition).toBe("USED_EXCELLENT");
    });

    it("should override product title", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        inventory: {
          product: {
            title: "New Product Title",
          },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.inventory.product.title).toBe("New Product Title");
    });

    it("should override product description", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        inventory: {
          product: {
            description: "New description text",
          },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.inventory.product.description).toBe("New description text");
    });

    it("should override product imageUrls", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        inventory: {
          product: {
            imageUrls: ["url1.jpg", "url2.jpg", "url3.jpg"],
          },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      // Should be proxied
      expect(result.inventory.product.imageUrls).toEqual([
        "proxied:url1.jpg",
        "proxied:url2.jpg",
        "proxied:url3.jpg",
      ]);
    });

    it("should limit imageUrls to 12 maximum", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        inventory: {
          product: {
            imageUrls: Array.from({ length: 20 }, (_, i) => `url${i}.jpg`),
          },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.inventory.product.imageUrls).toHaveLength(12);
    });

    it("should convert non-string imageUrls to strings", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        inventory: {
          product: {
            imageUrls: [123, null, "valid.jpg", undefined],
          },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.inventory.product.imageUrls).toEqual([
        "proxied:123",
        "proxied:valid.jpg",
      ]);
    });
  });

  describe("override application - aspects", () => {
    it("should merge aspects with base", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        inventory: {
          product: {
            aspects: {
              Brand: ["NewBrand"],
              Material: ["Cotton"],
            },
          },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.inventory.product.aspects).toEqual({
        Brand: ["NewBrand"],
        Color: ["Blue"],
        Material: ["Cotton"],
      });
    });

    it("should delete aspect when value is null", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        inventory: {
          product: {
            aspects: {
              Color: null,
            },
          },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.inventory.product.aspects).toEqual({
        Brand: ["BaseBrand"],
      });
      expect(result.inventory.product.aspects.Color).toBeUndefined();
    });

    it("should trim and filter aspect values", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        inventory: {
          product: {
            aspects: {
              Material: ["  Cotton  ", "", "   ", "Polyester"],
            },
          },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.inventory.product.aspects.Material).toEqual(["Cotton", "Polyester"]);
    });

    it("should ignore non-array aspect values", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        inventory: {
          product: {
            aspects: {
              Brand: "NotAnArray",
            },
          },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.inventory.product.aspects.Brand).toEqual(["BaseBrand"]);
    });

    it("should convert aspect values to strings", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        inventory: {
          product: {
            aspects: {
              Size: [42, null, undefined, "Large"],
            },
          },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.inventory.product.aspects.Size).toEqual(["42", "Large"]);
    });
  });

  describe("override application - offer", () => {
    it("should override marketplaceId", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        offer: {
          marketplaceId: "EBAY_GB",
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.offer.marketplaceId).toBe("EBAY_GB");
      expect(result._meta.marketplaceId).toBe("EBAY_GB");
    });

    it("should override categoryId", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        offer: {
          categoryId: "67890",
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.offer.categoryId).toBe("67890");
      expect(result._meta.categoryId).toBe("67890");
    });

    it("should override price with proper rounding", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        offer: {
          price: 49.999,
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.offer.price).toBe(50.0);
      expect(result._meta.price).toBe(50.0);
    });

    it("should ignore negative price", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        offer: {
          price: -10,
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.offer.price).toBe(99.99);
    });

    it("should ignore zero price", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        offer: {
          price: 0,
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.offer.price).toBe(99.99);
    });

    it("should ignore infinite price", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        offer: {
          price: Infinity,
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.offer.price).toBe(99.99);
    });

    it("should override quantity with truncation", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        offer: {
          quantity: 5.7,
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.offer.quantity).toBe(5);
    });

    it("should ignore negative quantity", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        offer: {
          quantity: -5,
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.offer.quantity).toBe(1);
    });

    it("should override condition", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        offer: {
          condition: 3000,
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.offer.condition).toBe(3000);
    });

    it("should override fulfillmentPolicyId", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        offer: {
          fulfillmentPolicyId: "new-fp",
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.offer.fulfillmentPolicyId).toBe("new-fp");
    });

    it("should set fulfillmentPolicyId to null when explicitly null", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        offer: {
          fulfillmentPolicyId: null,
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.offer.fulfillmentPolicyId).toBeNull();
    });

    it("should override paymentPolicyId", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        offer: {
          paymentPolicyId: "new-pp",
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.offer.paymentPolicyId).toBe("new-pp");
    });

    it("should override returnPolicyId", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        offer: {
          returnPolicyId: "new-rp",
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.offer.returnPolicyId).toBe("new-rp");
    });

    it("should override merchantLocationKey", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        offer: {
          merchantLocationKey: "new-loc",
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.offer.merchantLocationKey).toBe("new-loc");
    });

    it("should override offer description", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        offer: {
          description: "New offer description",
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.offer.description).toBe("New offer description");
    });
  });

  describe("override application - _meta", () => {
    it("should override selectedCategory", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        _meta: {
          selectedCategory: {
            id: "99999",
            slug: "new-category",
            title: "New Category",
          },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result._meta.selectedCategory).toEqual({
        id: "99999",
        slug: "new-category",
        title: "New Category",
      });
    });

    it("should override missingRequired array", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        _meta: {
          missingRequired: ["Brand", "Size", "Color"],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result._meta.missingRequired).toEqual(["Brand", "Size", "Color"]);
    });

    it("should convert missingRequired values to strings", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        _meta: {
          missingRequired: [123, null, "Brand", undefined],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result._meta.missingRequired).toEqual(["123", "null", "Brand", "null"]);
    });

    it("should handle non-array missingRequired as empty array", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        _meta: {
          missingRequired: "not-an-array",
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result._meta.missingRequired).toEqual([]);
    });
  });

  describe("complex override scenarios", () => {
    it("should apply multiple overrides at once", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        sku: "MULTI-OVERRIDE",
        inventory: {
          condition: "USED_GOOD",
          product: {
            title: "Multi Override Title",
            aspects: {
              Brand: ["NewBrand"],
              Size: ["Large"],
            },
          },
        },
        offer: {
          price: 75.50,
          quantity: 10,
          categoryId: "88888",
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.sku).toBe("MULTI-OVERRIDE");
      expect(result.inventory.condition).toBe("USED_GOOD");
      expect(result.inventory.product.title).toBe("Multi Override Title");
      expect(result.inventory.product.aspects.Brand).toEqual(["NewBrand"]);
      expect(result.inventory.product.aspects.Size).toEqual(["Large"]);
      expect(result.offer.price).toBe(75.5);
      expect(result.offer.quantity).toBe(10);
      expect(result.offer.categoryId).toBe("88888");
    });

    it("should preserve base values not in override", async () => {
      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const override = {
        inventory: {
          product: {
            title: "Only Title Changed",
          },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(override) }),
      });

      const group = { groupId: "g123" };
      const result = await mapGroupToDraft(group, { userId: "u1", jobId: "j1" });

      expect(result.inventory.product.title).toBe("Only Title Changed");
      expect(result.inventory.product.description).toBe("Base description");
      expect(result.inventory.condition).toBe("NEW");
      expect(result.offer.price).toBe(99.99);
    });
  });

  describe("EmptyImagesError guardrail", () => {
    it("should throw EmptyImagesError when draft has no images", async () => {
      // Reset modules to get a fresh import
      jest.resetModules();
      
      // Mock taxonomy to return draft with empty images
      const draftWithNoImages = JSON.parse(JSON.stringify(baseDraft));
      draftWithNoImages.inventory.product.imageUrls = [];
      
      jest.doMock("../../src/lib/taxonomy-map.js", () => ({
        mapGroupToDraftWithTaxonomy: jest.fn().mockResolvedValue(draftWithNoImages),
      }));
      jest.doMock("../../src/lib/image-utils.js", () => ({
        proxyImageUrls: jest.fn((urls: string[]) => urls),
      }));

      const { mapGroupToDraft, EmptyImagesError } = await import("../../src/lib/map-group-to-draft.js");

      const group = {
        groupId: "test-group-123",
        images: ["https://www.dropbox.com/s/abc/image.jpg?dl=0"],
      };

      // Suppress console.error for this test
      jest.spyOn(console, "error").mockImplementation();

      await expect(mapGroupToDraft(group)).rejects.toThrow(EmptyImagesError);
    });

    it("should pass when draft has at least 1 valid image", async () => {
      // Reset modules to get a fresh import
      jest.resetModules();
      
      // Mock taxonomy to return draft with 1 image
      const draftWithImage = JSON.parse(JSON.stringify(baseDraft));
      draftWithImage.inventory.product.imageUrls = ["https://example.com/valid-image.jpg"];
      
      jest.doMock("../../src/lib/taxonomy-map.js", () => ({
        mapGroupToDraftWithTaxonomy: jest.fn().mockResolvedValue(draftWithImage),
      }));
      jest.doMock("../../src/lib/image-utils.js", () => ({
        proxyImageUrls: jest.fn((urls: string[]) => urls.map((u: string) => `proxied:${u}`)),
      }));

      const { mapGroupToDraft } = await import("../../src/lib/map-group-to-draft.js");

      const group = {
        groupId: "test-group-456",
        images: ["https://example.com/valid-image.jpg"],
      };

      const result = await mapGroupToDraft(group);

      // Should complete without throwing
      expect(result.inventory.product.imageUrls).toHaveLength(1);
      expect(result.inventory.product.imageUrls[0]).toContain("proxied:");
    });
  });
});
