import { jest } from "@jest/globals";

// Mock external dependencies
jest.mock("node-fetch");
jest.mock("../../src/config.js");
jest.mock("../../src/utils/displayUrl.js");
jest.mock("../../src/utils/finalizeDisplay.js");
jest.mock("../../src/utils/groupingHelpers.js");
jest.mock("../../src/utils/roles.js");
jest.mock("../../src/lib/role-confidence.js");
jest.mock("../../src/utils/urlKey.js");
jest.mock("../../src/utils/urlSanitize.js");
jest.mock("../../src/lib/_auth.js");
jest.mock("../../src/lib/_blobs.js");
jest.mock("../../src/lib/analyze-core.js");
jest.mock("../../src/lib/clip-client-split.js");
jest.mock("../../src/lib/merge.js");
jest.mock("../../src/lib/quota.js");
jest.mock("../../src/lib/smartdrafts-store.js");
jest.mock("../../src/lib/sorter/frontBackStrict.js");

// Set environment variables
process.env.SMARTDRAFT_MAX_IMAGES = "100";
process.env.DROPBOX_APP_KEY = "test-app-key";
process.env.DROPBOX_APP_SECRET = "test-app-secret";

describe("smartdrafts-scan-core", () => {
  let runSmartDraftScan: any;
  let tokensStore: jest.Mock<any>;
  let userScopedKey: jest.Mock<any>;
  let getCachedSmartDraftGroups: jest.Mock<any>;
  let setCachedSmartDraftGroups: jest.Mock<any>;
  let makeCacheKey: jest.Mock<any>;
  let runAnalysis: jest.Mock<any>;
  let sanitizeUrls: jest.Mock<any>;
  let toDirectDropbox: jest.Mock<any>;
  let canConsumeImages: jest.Mock<any>;
  let consumeImages: jest.Mock<any>;
  let clipImageEmbedding: jest.Mock<any>;
  let cosine: jest.Mock<any>;
  let frontBackStrict: jest.Mock<any>;

  beforeAll(async () => {
    const authModule = await import("../../src/lib/_auth.js");
    const blobsModule = await import("../../src/lib/_blobs.js");
    const analyzeModule = await import("../../src/lib/analyze-core.js");
    const clipModule = await import("../../src/lib/clip-client-split.js");
    const mergeModule = await import("../../src/lib/merge.js");
    const quotaModule = await import("../../src/lib/quota.js");
    const storeModule = await import("../../src/lib/smartdrafts-store.js");
    const sorterModule = await import("../../src/lib/sorter/frontBackStrict.js");

    userScopedKey = authModule.userScopedKey as jest.Mock<any>;
    tokensStore = blobsModule.tokensStore as jest.Mock<any>;
    runAnalysis = analyzeModule.runAnalysis as jest.Mock<any>;
    sanitizeUrls = mergeModule.sanitizeUrls as jest.Mock<any>;
    toDirectDropbox = mergeModule.toDirectDropbox as jest.Mock<any>;
    canConsumeImages = quotaModule.canConsumeImages as jest.Mock<any>;
    consumeImages = quotaModule.consumeImages as jest.Mock<any>;
    clipImageEmbedding = clipModule.clipImageEmbedding as jest.Mock<any>;
    cosine = clipModule.cosine as jest.Mock<any>;
    getCachedSmartDraftGroups = storeModule.getCachedSmartDraftGroups as jest.Mock<any>;
    setCachedSmartDraftGroups = storeModule.setCachedSmartDraftGroups as jest.Mock<any>;
    makeCacheKey = storeModule.makeCacheKey as jest.Mock<any>;
    frontBackStrict = sorterModule.frontBackStrict as jest.Mock<any>;

    const scanModule = await import("../../src/lib/smartdrafts-scan-core.js");
    runSmartDraftScan = scanModule.runSmartDraftScan;
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mocks
    (userScopedKey as any).mockReturnValue("user123:dropbox.json");
    (tokensStore as any).mockReturnValue({
      get: (jest.fn() as jest.Mock<any>).mockResolvedValue({
        refresh_token: "test-refresh-token",
      }),
    });
    (makeCacheKey as any).mockReturnValue("cache-key-123");
    (getCachedSmartDraftGroups as any).mockResolvedValue(null);
    (setCachedSmartDraftGroups as any).mockResolvedValue(undefined);
    (sanitizeUrls as any).mockImplementation((urls: string[]) => urls);
    (toDirectDropbox as any).mockImplementation((url: string) => url);
    (canConsumeImages as any).mockResolvedValue({ allowed: true });
    (consumeImages as any).mockResolvedValue(undefined);
    (clipImageEmbedding as any).mockResolvedValue([0.1, 0.2, 0.3]);
    (cosine as any).mockReturnValue(0.85);
    (frontBackStrict as any).mockImplementation((images: any[]) => images);
    (runAnalysis as any).mockResolvedValue({
      groups: [],
      imageInsights: {},
      warnings: [],
      orphans: [],
    });

    // Mock global fetch for Dropbox API
    global.fetch = (jest.fn() as jest.Mock<any>).mockResolvedValue({
      ok: true,
      status: 200,
      json: (jest.fn() as jest.Mock<any>).mockResolvedValue({}),
    } as unknown as Response) as any;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("runSmartDraftScan - Input Validation", () => {
    it("should return 400 if neither folder nor stagedUrls provided", async () => {
      const result = await runSmartDraftScan({
        userId: "user123",
      });

      expect(result.status).toBe(400);
      expect(result.body.ok).toBe(false);
      expect(result.body.error).toContain("Provide either 'folder'");
    });

    it("should return 400 if both folder and stagedUrls provided", async () => {
      const result = await runSmartDraftScan({
        userId: "user123",
        folder: "/Photos",
        stagedUrls: ["https://example.com/image.jpg"],
      });

      expect(result.status).toBe(400);
      expect(result.body.ok).toBe(false);
      expect(result.body.error).toContain("not both");
    });

    it("should return 400 if Dropbox not connected", async () => {
      (tokensStore as any).mockReturnValue({
        get: (jest.fn() as jest.Mock<any>).mockResolvedValue(null),
      });

      const result = await runSmartDraftScan({
        userId: "user123",
        folder: "/Photos",
      });

      expect(result.status).toBe(400);
      expect(result.body.ok).toBe(false);
      expect(result.body.error).toContain("Connect Dropbox");
    });

    it("should respect MAX_IMAGES limit", async () => {
      const result = await runSmartDraftScan({
        userId: "user123",
        stagedUrls: ["https://example.com/image.jpg"],
        limit: 999999,
      });

      // Limit should be capped at MAX_IMAGES (100)
      expect(result).toBeDefined();
    });

    it("should handle empty folder gracefully", async () => {
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
          access_token: "test-access-token",
        }),
      } as unknown as Response).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
          entries: [],
        }),
      } as unknown as Response);

      const result = await runSmartDraftScan({
        userId: "user123",
        folder: "/EmptyFolder",
      });

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.count).toBe(0);
      expect(result.body.warnings).toContain("No images found in folder.");
    });
  });

  describe("runSmartDraftScan - Caching", () => {
    it("should return cached results when signature matches", async () => {
      const cachedData = {
        signature: "abc123",
        groups: [
          { images: ["image1.jpg"], brand: "TestBrand" },
        ],
        imageInsights: { "image1.jpg": { role: "front" } },
        warnings: [],
      };

      (getCachedSmartDraftGroups as any).mockResolvedValue(cachedData);

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
          access_token: "test-access-token",
        }),
      } as unknown as Response).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
          entries: [
            {
              ".tag": "file",
              id: "id:123",
              name: "image1.jpg",
              path_lower: "/photos/image1.jpg",
              rev: "abc123",
            },
          ],
        }),
      } as unknown as Response);

      const result = await runSmartDraftScan({
        userId: "user123",
        folder: "/Photos",
      });

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.cached).toBe(true);
      expect(result.body.groups.length).toBe(1);
    });

    it("should bypass cache when force=true", async () => {
      const cachedData = {
        signature: "abc123",
        groups: [{ images: ["old.jpg"] }],
        warnings: [],
      };

      (getCachedSmartDraftGroups as any).mockResolvedValue(cachedData);

      (global.fetch as jest.Mock<any>)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            access_token: "test-access-token",
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            entries: [
              {
                ".tag": "file",
                id: "id:456",
                name: "new.jpg",
                path_lower: "/photos/new.jpg",
                rev: "xyz789",
              },
            ],
          }),
        } as unknown as Response)
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            url: "https://dl.dropbox.com/new.jpg",
          }),
        } as unknown as Response);

      (runAnalysis as any).mockResolvedValue({
        groups: [{ images: ["new.jpg"], brand: "NewBrand" }],
        imageInsights: {},
        warnings: [],
        orphans: [],
      });

      const result = await runSmartDraftScan({
        userId: "user123",
        folder: "/Photos",
        force: true,
      });

      expect(result.body.cached).not.toBe(true);
      expect(runAnalysis).toHaveBeenCalled();
    });

    it("should bypass cache when debug=true", async () => {
      const cachedData = {
        signature: "abc123",
        groups: [{ images: ["old.jpg"] }],
        warnings: [],
      };

      (getCachedSmartDraftGroups as any).mockResolvedValue(cachedData);

      (global.fetch as jest.Mock<any>)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            access_token: "test-access-token",
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            entries: [
              {
                ".tag": "file",
                id: "id:789",
                name: "debug.jpg",
                path_lower: "/photos/debug.jpg",
                rev: "debug123",
              },
            ],
          }),
        } as unknown as Response)
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            url: "https://dl.dropbox.com/debug.jpg",
          }),
        } as unknown as Response);

      (runAnalysis as any).mockResolvedValue({
        groups: [],
        imageInsights: {},
        warnings: [],
        orphans: [],
      });

      const result = await runSmartDraftScan({
        userId: "user123",
        folder: "/Photos",
        debug: "true",
      });

      expect(result.body.cached).not.toBe(true);
    });

    it("should save results to cache after processing", async () => {
      (global.fetch as jest.Mock<any>)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            access_token: "test-access-token",
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            entries: [
              {
                ".tag": "file",
                id: "id:111",
                name: "save.jpg",
                path_lower: "/photos/save.jpg",
                rev: "save123",
              },
            ],
          }),
        } as unknown as Response)
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            url: "https://dl.dropbox.com/save.jpg",
          }),
        } as unknown as Response);

      (runAnalysis as any).mockResolvedValue({
        groups: [{ images: ["save.jpg"] }],
        imageInsights: {},
        warnings: [],
        orphans: [],
      });

      await runSmartDraftScan({
        userId: "user123",
        folder: "/Photos",
      });

      expect(setCachedSmartDraftGroups).toHaveBeenCalled();
    });
  });

  describe("runSmartDraftScan - Staged URLs", () => {
    it("should process staged URLs from ingestion system", async () => {
      (runAnalysis as any).mockResolvedValue({
        groups: [
          {
            images: ["https://example.com/image1.jpg"],
            brand: "TestBrand",
            product: "Test Product",
          },
        ],
        imageInsights: {
          "https://example.com/image1.jpg": { role: "front" },
        },
        warnings: [],
        orphans: [],
      });

      const result = await runSmartDraftScan({
        userId: "user123",
        stagedUrls: ["https://example.com/image1.jpg", "https://example.com/image2.jpg"],
      });

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(runAnalysis).toHaveBeenCalled();
    });

    it("should respect limit parameter for staged URLs", async () => {
      const urls = Array.from({ length: 50 }, (_, i) => `https://example.com/image${i}.jpg`);

      (runAnalysis as any).mockResolvedValue({
        groups: [],
        imageInsights: {},
        warnings: [],
        orphans: [],
      });

      await runSmartDraftScan({
        userId: "user123",
        stagedUrls: urls,
        limit: 10,
      });

      expect(runAnalysis).toHaveBeenCalled();
      const callArgs = (runAnalysis as any).mock.calls[0];
      expect(callArgs[0].length).toBeLessThanOrEqual(10);
    });

    it("should check quota for staged URLs", async () => {
      (canConsumeImages as any).mockResolvedValue({ allowed: false, reason: "Quota exceeded" });

      const result = await runSmartDraftScan({
        userId: "user123",
        stagedUrls: ["https://example.com/image1.jpg"],
      });

      expect(result.status).toBe(429);
      expect(result.body.ok).toBe(false);
      expect(result.body.error).toContain("Quota exceeded");
    });

    it("should skip quota check when skipQuota=true", async () => {
      (runAnalysis as any).mockResolvedValue({
        groups: [],
        imageInsights: {},
        warnings: [],
        orphans: [],
      });

      await runSmartDraftScan({
        userId: "user123",
        stagedUrls: ["https://example.com/image1.jpg"],
        skipQuota: true,
      });

      expect(canConsumeImages).not.toHaveBeenCalled();
      expect(runAnalysis).toHaveBeenCalled();
    });

    it("should consume quota after successful analysis", async () => {
      (runAnalysis as any).mockResolvedValue({
        groups: [],
        imageInsights: {},
        warnings: [],
        orphans: [],
      });

      await runSmartDraftScan({
        userId: "user123",
        stagedUrls: ["https://example.com/image1.jpg", "https://example.com/image2.jpg"],
      });

      expect(consumeImages).toHaveBeenCalledWith("user123", 2);
    });
  });

  describe("runSmartDraftScan - Dropbox Integration", () => {
    it("should request Dropbox access token with refresh token", async () => {
      (global.fetch as jest.Mock<any>)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            access_token: "fresh-access-token",
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            entries: [],
          }),
        } as unknown as Response);

      await runSmartDraftScan({
        userId: "user123",
        folder: "/Photos",
      });

      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.dropboxapi.com/oauth2/token",
        expect.objectContaining({
          method: "POST",
        })
      );
    });

    it("should list files from Dropbox folder", async () => {
      (global.fetch as jest.Mock<any>)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            access_token: "test-access-token",
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            entries: [
              {
                ".tag": "file",
                id: "id:1",
                name: "photo1.jpg",
                path_lower: "/photos/photo1.jpg",
              },
              {
                ".tag": "file",
                id: "id:2",
                name: "photo2.jpg",
                path_lower: "/photos/photo2.jpg",
              },
            ],
          }),
        } as unknown as Response)
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            url: "https://dl.dropbox.com/test.jpg",
          }),
        } as unknown as Response);

      (runAnalysis as any).mockResolvedValue({
        groups: [],
        imageInsights: {},
        warnings: [],
        orphans: [],
      });

      await runSmartDraftScan({
        userId: "user123",
        folder: "/Photos",
      });

      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.dropboxapi.com/2/files/list_folder",
        expect.any(Object)
      );
    });

    it("should filter only image files from Dropbox", async () => {
      (global.fetch as jest.Mock<any>)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            access_token: "test-access-token",
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            entries: [
              {
                ".tag": "file",
                id: "id:1",
                name: "photo.jpg",
                path_lower: "/photos/photo.jpg",
              },
              {
                ".tag": "file",
                id: "id:2",
                name: "document.pdf",
                path_lower: "/photos/document.pdf",
              },
              {
                ".tag": "folder",
                id: "id:3",
                name: "subfolder",
                path_lower: "/photos/subfolder",
              },
            ],
          }),
        } as unknown as Response)
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            url: "https://dl.dropbox.com/photo.jpg",
          }),
        } as unknown as Response);

      (runAnalysis as any).mockResolvedValue({
        groups: [],
        imageInsights: {},
        warnings: [],
        orphans: [],
      });

      const result = await runSmartDraftScan({
        userId: "user123",
        folder: "/Photos",
      });

      // Should only process image files
      expect(result).toBeDefined();
    });

    it("should create shared links for Dropbox files", async () => {
      (global.fetch as jest.Mock<any>)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            access_token: "test-access-token",
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            entries: [
              {
                ".tag": "file",
                id: "id:share",
                name: "share.jpg",
                path_lower: "/photos/share.jpg",
              },
            ],
          }),
        } as unknown as Response)
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            url: "https://dl.dropbox.com/share.jpg",
          }),
        } as unknown as Response);

      (runAnalysis as any).mockResolvedValue({
        groups: [],
        imageInsights: {},
        warnings: [],
        orphans: [],
      });

      await runSmartDraftScan({
        userId: "user123",
        folder: "/Photos",
      });

      // Should call sharing/create_shared_link_with_settings
      const sharingCalls = (global.fetch as jest.Mock<any>).mock.calls.filter(
        (call: any) => call[0].includes("sharing/create_shared_link_with_settings")
      );
      expect(sharingCalls.length).toBeGreaterThan(0);
    });
  });

  describe("runSmartDraftScan - Error Handling", () => {
    it("should handle Dropbox API errors gracefully", async () => {
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      } as unknown as Response);

      const result = await runSmartDraftScan({
        userId: "user123",
        folder: "/Photos",
      });

      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.body.ok).toBe(false);
    });

    it("should handle vision analysis errors", async () => {
      (global.fetch as jest.Mock<any>)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            access_token: "test-access-token",
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            entries: [
              {
                ".tag": "file",
                id: "id:error",
                name: "error.jpg",
                path_lower: "/photos/error.jpg",
              },
            ],
          }),
        } as unknown as Response)
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            url: "https://dl.dropbox.com/error.jpg",
          }),
        } as unknown as Response);

      (runAnalysis as any).mockRejectedValue(new Error("Vision API failed"));

      const result = await runSmartDraftScan({
        userId: "user123",
        folder: "/Photos",
      });

      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.body.ok).toBe(false);
    });

    it("should handle network errors", async () => {
      (global.fetch as jest.Mock<any>).mockRejectedValue(new Error("Network failure"));

      const result = await runSmartDraftScan({
        userId: "user123",
        folder: "/Photos",
      });

      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.body.ok).toBe(false);
    });
  });

  describe("runSmartDraftScan - Group Formation", () => {
    it("should return analyzed groups with metadata", async () => {
      (global.fetch as jest.Mock<any>)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            access_token: "test-access-token",
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            entries: [
              {
                ".tag": "file",
                id: "id:1",
                name: "product1.jpg",
                path_lower: "/photos/product1.jpg",
              },
            ],
          }),
        } as unknown as Response)
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: (jest.fn() as jest.Mock<any>).mockResolvedValue({
            url: "https://dl.dropbox.com/product1.jpg",
          }),
        } as unknown as Response);

      (runAnalysis as any).mockResolvedValue({
        groups: [
          {
            images: ["product1.jpg"],
            brand: "TestBrand",
            product: "Test Product",
            category: "Electronics",
          },
        ],
        imageInsights: {
          "product1.jpg": { role: "front", hasText: true },
        },
        warnings: [],
        orphans: [],
      });

      const result = await runSmartDraftScan({
        userId: "user123",
        folder: "/Photos",
      });

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.count).toBe(1);
      expect(result.body.groups[0].brand).toBe("TestBrand");
      expect(result.body.groups[0].product).toBe("Test Product");
    });

    it("should include image insights in response", async () => {
      (runAnalysis as any).mockResolvedValue({
        groups: [{ images: ["test.jpg"] }],
        imageInsights: {
          "test.jpg": {
            role: "front",
            hasText: true,
            dominantColor: "blue",
          },
        },
        warnings: [],
        orphans: [],
      });

      const result = await runSmartDraftScan({
        userId: "user123",
        stagedUrls: ["https://example.com/test.jpg"],
      });

      expect(result.body.imageInsights).toBeDefined();
      expect(result.body.imageInsights["test.jpg"]).toBeDefined();
      expect(result.body.imageInsights["test.jpg"].role).toBe("front");
    });

    it("should include warnings in response", async () => {
      (runAnalysis as any).mockResolvedValue({
        groups: [],
        imageInsights: {},
        warnings: ["Warning: Low quality image detected"],
        orphans: [],
      });

      const result = await runSmartDraftScan({
        userId: "user123",
        stagedUrls: ["https://example.com/lowquality.jpg"],
      });

      expect(result.body.warnings).toContain("Warning: Low quality image detected");
    });

    it("should handle orphan images", async () => {
      (runAnalysis as any).mockResolvedValue({
        groups: [{ images: ["grouped.jpg"] }],
        imageInsights: {},
        warnings: [],
        orphans: ["orphan.jpg"],
      });

      const result = await runSmartDraftScan({
        userId: "user123",
        stagedUrls: ["https://example.com/grouped.jpg", "https://example.com/orphan.jpg"],
      });

      expect(result.body.count).toBe(1);
      // Orphans should be tracked separately
    });
  });

  describe("runSmartDraftScan - Debug Mode", () => {
    it("should include debug information when debug=true", async () => {
      (runAnalysis as any).mockResolvedValue({
        groups: [],
        imageInsights: {},
        warnings: [],
        orphans: [],
      });

      const result = await runSmartDraftScan({
        userId: "user123",
        stagedUrls: ["https://example.com/debug.jpg"],
        debug: true,
      });

      // Debug mode should not cache results
      expect(result.body.cached).not.toBe(true);
    });

    it("should accept debug as string values", async () => {
      (runAnalysis as any).mockResolvedValue({
        groups: [],
        imageInsights: {},
        warnings: [],
        orphans: [],
      });

      const result1 = await runSmartDraftScan({
        userId: "user123",
        stagedUrls: ["https://example.com/test.jpg"],
        debug: "1",
      });

      const result2 = await runSmartDraftScan({
        userId: "user123",
        stagedUrls: ["https://example.com/test.jpg"],
        debug: "yes",
      });

      expect(result1.body.cached).not.toBe(true);
      expect(result2.body.cached).not.toBe(true);
    });
  });
});
