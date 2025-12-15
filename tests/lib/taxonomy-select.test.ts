describe("taxonomy-select", () => {
  let mockListCategories: jest.Mock;
  let mockGetCategoryById: jest.Mock;

  const mockCategory = (
    id: string,
    title: string,
    slug: string,
    scoreRules?: { includes?: string[]; excludes?: string[]; minScore?: number }
  ) => ({
    id,
    slug,
    title,
    marketplaceId: "EBAY_US",
    version: 1,
    updatedAt: Date.now(),
    itemSpecifics: [],
    scoreRules,
  });

  beforeEach(() => {
    jest.resetModules();
    mockListCategories = jest.fn();
    mockGetCategoryById = jest.fn();

    jest.spyOn(console, "log").mockImplementation();
    jest.spyOn(console, "warn").mockImplementation();

    jest.doMock("../../src/lib/taxonomy-store.js", () => ({
      listCategories: mockListCategories,
      getCategoryById: mockGetCategoryById,
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("pickCategoryForGroup", () => {
    describe("direct category ID lookup", () => {
      it("should find category by category.id", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const targetCategory = mockCategory("12345", "Books", "Books");
        mockGetCategoryById.mockResolvedValueOnce(targetCategory);

        const group = {
          category: { id: "12345" },
          brand: "Test Brand",
        };

        const result = await pickCategoryForGroup(group);

        expect(result).toEqual(targetCategory);
        expect(mockGetCategoryById).toHaveBeenCalledWith("12345");
      });

      it("should find category by category.categoryId", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const targetCategory = mockCategory("67890", "Electronics", "Electronics");
        mockGetCategoryById.mockResolvedValueOnce(targetCategory);

        const group = {
          category: { categoryId: "67890" },
        };

        const result = await pickCategoryForGroup(group);

        expect(result).toEqual(targetCategory);
        expect(mockGetCategoryById).toHaveBeenCalledWith("67890");
      });

      it("should trim whitespace from category ID", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const targetCategory = mockCategory("123", "Test", "Test");
        mockGetCategoryById.mockResolvedValueOnce(targetCategory);

        const group = {
          category: { id: "  123  " },
        };

        await pickCategoryForGroup(group);

        expect(mockGetCategoryById).toHaveBeenCalledWith("123");
      });

      it("should skip category ID lookup when ID is empty", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        mockListCategories.mockResolvedValueOnce([]);

        const group = {
          category: { id: "" },
        };

        await pickCategoryForGroup(group);

        expect(mockGetCategoryById).not.toHaveBeenCalled();
      });
    });

    describe("category title exact matching", () => {
      it("should match category by exact title", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Books", "Books"),
          mockCategory("2", "Electronics", "Electronics"),
        ];
        mockGetCategoryById.mockResolvedValueOnce(null);
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          category: { title: "Books" },
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("1");
        expect(result?.title).toBe("Books");
      });

      it("should match category by slug", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Health & Beauty", "health-beauty"),
        ];
        mockGetCategoryById.mockResolvedValueOnce(null);
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          category: { title: "health-beauty" },
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("1");
      });

      it("should be case-insensitive for title matching", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Books", "Books"),
        ];
        mockGetCategoryById.mockResolvedValueOnce(null);
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          category: { title: "BOOKS" },
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("1");
      });

      it("should trim whitespace when matching title", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Books", "Books"),
        ];
        mockGetCategoryById.mockResolvedValueOnce(null);
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          category: { title: "  Books  " },
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("1");
      });
    });

    describe("category path matching", () => {
      it("should match last part of path (most specific)", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Biography", "Books > Biography"),
        ];
        mockGetCategoryById.mockResolvedValueOnce(null);
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          category: { title: "Books > Biography" },
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("1");
        expect(result?.title).toBe("Biography");
      });

      it("should match full path in slug", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Collectible Coins", "Collectibles > Coins"),
        ];
        mockGetCategoryById.mockResolvedValueOnce(null);
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          category: { title: "Collectibles > Coins" },
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("1");
      });

      it("should fuzzy match path parts", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Biography", "Books > Non-Fiction > Biography"),
        ];
        mockGetCategoryById.mockResolvedValueOnce(null);
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          category: { title: "Books > Biography" },
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("1");
      });

      it("should require N-1 parts to match for fuzzy matching", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Unrelated", "Totally > Different > Path"),
        ];
        mockGetCategoryById.mockResolvedValueOnce(null);
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          category: { title: "Books > Biography > Memoirs" },
        };

        const result = await pickCategoryForGroup(group);

        // Should not match - only 0 of 3 parts match
        expect(result).toBeNull();
      });

      it("should choose best fuzzy match by part count", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Partial Match", "Books > Fiction"),
          mockCategory("2", "Better Match", "Books > Non-Fiction > Biography"),
        ];
        mockGetCategoryById.mockResolvedValueOnce(null);
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          category: { title: "Books > Non-Fiction > Biography" },
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("2");
      });
    });

    describe("enhanced scoreRules matching with category keywords", () => {
      it("should enhance haystack with category keywords from path", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Biography", "Books > Biography", {
            includes: ["biography", "books"],
            minScore: 2,
          }),
        ];
        mockGetCategoryById.mockResolvedValueOnce(null);
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          category: { title: "Books > Biography" },
          brand: "Publisher",
          product: "Historical Figure Story",
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("1");
      });

      it("should not enhance haystack if no path separator", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Books", "Books", {
            includes: ["books"],
            minScore: 1,
          }),
        ];
        mockGetCategoryById.mockResolvedValueOnce(null);
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          category: { title: "Books" },
          brand: "Publisher",
        };

        const result = await pickCategoryForGroup(group);

        // Falls back to regular scoreRules
        expect(result?.id).toBe("1");
      });
    });

    describe("fallback scoreRules matching", () => {
      it("should match by includes keywords in brand/product", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Vitamins", "Health > Vitamins", {
            includes: ["vitamin", "supplement"],
            minScore: 1,
          }),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          brand: "Nature's Best",
          product: "Vitamin C 1000mg",
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("1");
      });

      it("should match by includes keywords in variant", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Electronics", "Electronics", {
            includes: ["electronics", "gadget"],
            minScore: 1,
          }),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          variant: "Electronic Gadget",
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("1");
      });

      it("should match by includes keywords in category field", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Books", "Books", {
            includes: ["book", "novel"],
            minScore: 1,
          }),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          category: "Books and Novels",
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("1");
      });

      it("should match by includes keywords in claims array", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Sports", "Sports", {
            includes: ["fitness", "exercise"],
            minScore: 1,
          }),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          brand: "FitGear",
          claims: ["fitness equipment", "exercise accessories"],
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("1");
      });

      it("should exclude categories with excludes keywords", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Books", "Books", {
            includes: ["book"],
            excludes: ["audiobook", "ebook"],
            minScore: 1,
          }),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          product: "Audiobook Download",
        };

        const result = await pickCategoryForGroup(group);

        // Should not match because of exclude
        expect(result).toBeNull();
      });

      it("should penalize excludes more than includes", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Category", "Category", {
            includes: ["keyword"],
            excludes: ["bad"],
            minScore: 1,
          }),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          product: "keyword bad",
        };

        const result = await pickCategoryForGroup(group);

        // Score: +1 (keyword) -2 (bad) = -1, below minScore
        expect(result).toBeNull();
      });

      it("should respect minScore threshold", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Category", "Category", {
            includes: ["one", "two", "three"],
            minScore: 3,
          }),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          product: "one two",
        };

        const result = await pickCategoryForGroup(group);

        // Score: 2, below minScore of 3
        expect(result).toBeNull();
      });

      it("should default minScore to 1 if not specified", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Category", "Category", {
            includes: ["keyword"],
          }),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          product: "keyword",
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("1");
      });

      it("should choose category with highest score", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Low Score", "Low", {
            includes: ["one"],
            minScore: 1,
          }),
          mockCategory("2", "High Score", "High", {
            includes: ["one", "two", "three"],
            minScore: 1,
          }),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          product: "one two three",
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("2");
      });

      it("should be case-insensitive for keyword matching", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Category", "Category", {
            includes: ["vitamin"],
            minScore: 1,
          }),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          product: "VITAMIN C",
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("1");
      });

      it("should handle empty scoreRules includes array", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Category", "Category", {
            includes: [],
            minScore: 0,
          }),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          product: "anything",
        };

        const result = await pickCategoryForGroup(group);

        // Score: 0, meets minScore of 0
        expect(result?.id).toBe("1");
      });

      it("should handle missing scoreRules", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Category", "Category"),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          product: "anything",
        };

        const result = await pickCategoryForGroup(group);

        // No scoreRules, score: 0, minScore defaults to 1
        expect(result).toBeNull();
      });
    });

    describe("edge cases", () => {
      it("should return null when no categories exist", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        mockListCategories.mockResolvedValueOnce([]);

        const group = {
          brand: "Test",
          product: "Product",
        };

        const result = await pickCategoryForGroup(group);

        expect(result).toBeNull();
      });

      it("should return null when group has no searchable content", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Category", "Category", {
            includes: ["keyword"],
            minScore: 1,
          }),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {};

        const result = await pickCategoryForGroup(group);

        expect(result).toBeNull();
      });

      it("should ignore non-string values in group fields", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Category", "Category", {
            includes: ["keyword"],
            minScore: 1,
          }),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          brand: 123,
          product: null,
          variant: undefined,
          category: ["not", "string"],
        };

        const result = await pickCategoryForGroup(group);

        expect(result).toBeNull();
      });

      it("should ignore non-string values in claims array", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Category", "Category", {
            includes: ["keyword"],
            minScore: 1,
          }),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          product: "keyword",
          claims: [123, null, undefined, { obj: "value" }],
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("1");
      });

      it("should handle category object that is not an object", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Category", "Category", {
            includes: ["keyword"],
            minScore: 1,
          }),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          category: "string value",
          product: "keyword",
        };

        const result = await pickCategoryForGroup(group);

        // category string value gets added to haystack
        expect(result?.id).toBe("1");
      });

      it("should handle empty includes/excludes arrays in scoreRules", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Category", "Category", {
            includes: [],
            excludes: [],
            minScore: 0,
          }),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          product: "anything",
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("1");
      });

      it("should handle empty string in includes array", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Category", "Category", {
            includes: ["", "keyword"],
            minScore: 1,
          }),
        ];
        mockListCategories.mockResolvedValueOnce(categories);

        const group = {
          product: "keyword",
        };

        const result = await pickCategoryForGroup(group);

        expect(result?.id).toBe("1");
      });
    });

    describe("caching", () => {
      it("should cache category list for 30 seconds", async () => {
        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Category", "Category", {
            includes: ["keyword"],
            minScore: 1,
          }),
        ];
        mockListCategories.mockResolvedValue(categories);

        const group = { product: "keyword" };

        await pickCategoryForGroup(group);
        await pickCategoryForGroup(group);

        // Should only call listCategories once due to cache
        expect(mockListCategories).toHaveBeenCalledTimes(1);
      });

      it("should refresh cache after TTL expires", async () => {
        jest.resetModules();
        
        // Mock Date.now to control time
        const originalNow = Date.now;
        let currentTime = 1000000;
        jest.spyOn(Date, "now").mockImplementation(() => currentTime);

        mockListCategories = jest.fn();
        jest.doMock("../../src/lib/taxonomy-store.js", () => ({
          listCategories: mockListCategories,
          getCategoryById: jest.fn(),
        }));

        const { pickCategoryForGroup } = await import("../../src/lib/taxonomy-select.js");

        const categories = [
          mockCategory("1", "Category", "Category", {
            includes: ["keyword"],
            minScore: 1,
          }),
        ];
        mockListCategories.mockResolvedValue(categories);

        const group = { product: "keyword" };

        // First call
        await pickCategoryForGroup(group);
        expect(mockListCategories).toHaveBeenCalledTimes(1);

        // Advance time by 31 seconds (past TTL)
        currentTime += 31000;

        // Second call should refresh cache
        await pickCategoryForGroup(group);
        expect(mockListCategories).toHaveBeenCalledTimes(2);

        // Restore Date.now
        (Date.now as jest.Mock).mockRestore();
      });
    });
  });
});
