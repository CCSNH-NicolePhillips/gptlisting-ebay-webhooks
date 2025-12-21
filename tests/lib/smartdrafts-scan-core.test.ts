import { jest } from "@jest/globals";

// Mock external dependencies
jest.mock("node-fetch");
jest.mock("../../src/config.js");
jest.mock("../../src/utils/displayUrl.js");
jest.mock("../../src/utils/finalizeDisplay.js");
import { createHash } from "node:crypto";
import type { IngestedFile } from "../../src/ingestion/types.js";

type RunAnalysisFn = typeof import("../../src/lib/analyze-core.js")['runAnalysis'];
type TokensStoreFn = typeof import("../../src/lib/_blobs.js")['tokensStore'];
type CanConsumeFn = typeof import("../../src/lib/quota.js")['canConsumeImages'];
type ConsumeImagesFn = typeof import("../../src/lib/quota.js")['consumeImages'];
type SanitizeUrlsFn = typeof import("../../src/lib/merge.js")['sanitizeUrls'];
type ToDirectDropboxFn = typeof import("../../src/lib/merge.js")['toDirectDropbox'];
type MakeCacheKeyFn = typeof import("../../src/lib/smartdrafts-store.js")['makeCacheKey'];
type GetCachedFn = typeof import("../../src/lib/smartdrafts-store.js")['getCachedSmartDraftGroups'];
type SetCachedFn = typeof import("../../src/lib/smartdrafts-store.js")['setCachedSmartDraftGroups'];
type UrlKeyFn = typeof import("../../src/utils/urlKey.js")['urlKey'];
type MakeDisplayUrlFn = typeof import("../../src/utils/displayUrl.js")['makeDisplayUrl'];
type FinalizeDisplayUrlsFn = typeof import("../../src/utils/finalizeDisplay.js")['finalizeDisplayUrls'];
type SanitizeInsightUrlFn = typeof import("../../src/utils/urlSanitize.js")['sanitizeInsightUrl'];
type DropboxListFn = typeof import("../../src/ingestion/dropbox.js")['DropboxAdapter']['list'];
type ReassignOrphansFn = typeof import("../../src/lib/orphan-reassignment.js")['reassignOrphans'];
type ComputeRoleConfidenceBatchFn = typeof import("../../src/lib/role-confidence.js")['computeRoleConfidenceBatch'];
type CrossCheckGroupRolesFn = typeof import("../../src/lib/role-confidence.js")['crossCheckGroupRoles'];

const mockRunAnalysis: jest.MockedFunction<RunAnalysisFn> = jest.fn();
const mockTokensStore: jest.MockedFunction<TokensStoreFn> = jest.fn();
const mockStoreGet = jest.fn();
const mockCanConsumeImages: jest.MockedFunction<CanConsumeFn> = jest.fn();
const mockConsumeImages: jest.MockedFunction<ConsumeImagesFn> = jest.fn();
const mockSanitizeUrls: jest.MockedFunction<SanitizeUrlsFn> = jest.fn();
const mockToDirectDropbox: jest.MockedFunction<ToDirectDropboxFn> = jest.fn();
const mockMakeCacheKey: jest.MockedFunction<MakeCacheKeyFn> = jest.fn();
const mockGetCached: jest.MockedFunction<GetCachedFn> = jest.fn();
const mockSetCached: jest.MockedFunction<SetCachedFn> = jest.fn();
const mockUrlKey: jest.MockedFunction<UrlKeyFn> = jest.fn();
const mockMakeDisplayUrl: jest.MockedFunction<MakeDisplayUrlFn> = jest.fn();
const mockFinalizeDisplayUrls: jest.MockedFunction<FinalizeDisplayUrlsFn> = jest.fn();
const mockSanitizeInsightUrl: jest.MockedFunction<SanitizeInsightUrlFn> = jest.fn();
const mockDropboxList: jest.MockedFunction<DropboxListFn> = jest.fn();
const mockReassignOrphans: jest.MockedFunction<ReassignOrphansFn> = jest.fn();
const mockComputeRoleConfidenceBatch: jest.MockedFunction<ComputeRoleConfidenceBatchFn> = jest.fn();
const mockCrossCheckGroupRoles: jest.MockedFunction<CrossCheckGroupRolesFn> = jest.fn();

jest.mock("../../src/config.js", () => ({
  STRICT_TWO_ONLY: false,
  USE_CLIP: false,
  USE_NEW_SORTER: false,
  USE_ROLE_SORTING: false,
}));

jest.mock("../../src/utils/displayUrl.js", () => ({
  makeDisplayUrl: mockMakeDisplayUrl,
}));

jest.mock("../../src/utils/finalizeDisplay.js", () => ({
  finalizeDisplayUrls: mockFinalizeDisplayUrls,
}));

jest.mock("../../src/utils/groupingHelpers.js", () => ({
  categoryCompat: jest.fn(() => 0),
  jaccard: jest.fn(() => 0),
  normBrand: jest.fn((v: string) => v?.toLowerCase?.() || v),
  tokenize: jest.fn(() => []),
}));

jest.mock("../../src/utils/roles.js", () => ({
  buildRoleMap: jest.fn(() => new Map()),
}));

jest.mock("../../src/lib/role-confidence.js", () => ({
  computeRoleConfidenceBatch: mockComputeRoleConfidenceBatch,
  crossCheckGroupRoles: mockCrossCheckGroupRoles,
}));

jest.mock("../../src/utils/urlKey.js", () => ({ urlKey: mockUrlKey }));
jest.mock("../../src/utils/urlSanitize.js", () => ({ sanitizeInsightUrl: mockSanitizeInsightUrl }));
jest.mock("../../src/lib/_auth.js", () => ({
  userScopedKey: jest.fn((user: string, key: string) => `${user}:${key}`),
}));
jest.mock("../../src/lib/_blobs.js", () => ({ tokensStore: mockTokensStore }));
jest.mock("../../src/lib/analyze-core.js", () => ({ runAnalysis: mockRunAnalysis }));
jest.mock("../../src/lib/clip-client-split.js", () => ({
  clipImageEmbedding: jest.fn(async () => [0.1, 0.2, 0.3]),
  clipTextEmbedding: jest.fn(async () => [0.1, 0.2, 0.3]),
  clipProviderInfo: jest.fn(() => ({ provider: "mock", textBase: "t", imageBase: "i" })),
  cosine: jest.fn(() => 0.5),
}));
jest.mock("../../src/lib/merge.js", () => ({
  sanitizeUrls: mockSanitizeUrls,
  toDirectDropbox: mockToDirectDropbox,
}));
jest.mock("../../src/lib/quota.js", () => ({
  canConsumeImages: mockCanConsumeImages,
  consumeImages: mockConsumeImages,
}));
jest.mock("../../src/lib/smartdrafts-store.js", () => ({
  getCachedSmartDraftGroups: mockGetCached,
  setCachedSmartDraftGroups: mockSetCached,
  makeCacheKey: mockMakeCacheKey,
}));
jest.mock("../../src/lib/sorter/frontBackStrict.js", () => ({
  frontBackStrict: jest.fn((imgs: any[]) => imgs),
}));
jest.mock("../../src/ingestion/dropbox.js", () => ({
  DropboxAdapter: { list: mockDropboxList },
}));
jest.mock("../../src/lib/orphan-reassignment.js", () => ({
  reassignOrphans: mockReassignOrphans,
}));

let runSmartDraftScan: (opts: any) => Promise<any>;

beforeAll(async () => {
  process.env.SMARTDRAFT_MAX_IMAGES = "100";
  const module = await import("../../src/lib/smartdrafts-scan-core.js");
  runSmartDraftScan = module.runSmartDraftScan;
});

beforeEach(() => {
  jest.clearAllMocks();

  mockTokensStore.mockReturnValue({ get: mockStoreGet });
  mockStoreGet.mockResolvedValue({ refresh_token: "refresh-token" });
  mockMakeCacheKey.mockReturnValue("cache-key");
  mockGetCached.mockResolvedValue(null);
  mockSetCached.mockResolvedValue(undefined);
  mockRunAnalysis.mockResolvedValue({ groups: [], imageInsights: {}, warnings: [], orphans: [] });
  mockSanitizeUrls.mockImplementation((urls: string[]) => urls);
  mockToDirectDropbox.mockImplementation((url: string) => url);
  mockCanConsumeImages.mockResolvedValue(true);
  mockConsumeImages.mockResolvedValue(undefined);
  mockUrlKey.mockImplementation((url: string) => `key-${url}`);
  mockMakeDisplayUrl.mockImplementation((url: string) => url);
  mockFinalizeDisplayUrls.mockReturnValue(undefined as any);
  mockSanitizeInsightUrl.mockImplementation((url: string, fallback?: string) => url || fallback || "");
  mockDropboxList.mockResolvedValue([]);
  mockReassignOrphans.mockReturnValue([]);
  mockComputeRoleConfidenceBatch.mockReturnValue(new Map());
  mockCrossCheckGroupRoles.mockReturnValue({ groupId: "", corrections: [] });
});

const makeIngested = (overrides: Partial<IngestedFile> = {}): IngestedFile => ({
  id: overrides.id || "file-1",
  name: overrides.name || "image.jpg",
  mime: overrides.mime || "image/jpeg",
  bytes: overrides.bytes,
  stagedUrl: overrides.stagedUrl || "https://r2.example.com/image.jpg",
  meta: overrides.meta || { sourcePath: "/photos/image.jpg" },
});

describe("runSmartDraftScan - staged URLs", () => {
  it("returns cache hit when signature matches", async () => {
    const urls = ["https://cdn/a.jpg", "https://cdn/b.jpg"];
    const signature = createHash("sha256").update(JSON.stringify(urls.sort())).digest("hex").slice(0, 16);
    mockMakeCacheKey.mockReturnValue("staged-cache");
    mockGetCached.mockResolvedValue({
      signature,
      groups: [{ images: ["https://cdn/a.jpg"], brand: "Cached" }],
      warnings: ["cached"],
      imageInsights: { "https://cdn/a.jpg": { url: "https://cdn/a.jpg", role: "front" } },
    });

    const result = await runSmartDraftScan({ userId: "u1", stagedUrls: urls });

    expect(result.status).toBe(200);
    expect(result.body.cached).toBe(true);
    expect(mockRunAnalysis).not.toHaveBeenCalled();
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("rejects when quota blocks staged URLs", async () => {
    mockGetCached.mockResolvedValue(null);
    mockCanConsumeImages.mockResolvedValueOnce(false);

    const result = await runSmartDraftScan({ userId: "u1", stagedUrls: ["https://cdn/a.jpg"] });

    expect(result.status).toBe(429);
    expect(result.body.ok).toBe(false);
    expect(mockRunAnalysis).not.toHaveBeenCalled();
  });

  it("fails when sanitizeUrls removes everything", async () => {
    mockSanitizeUrls.mockReturnValue([]);

    const result = await runSmartDraftScan({ userId: "u1", stagedUrls: ["bad-url"] });

    expect(result.status).toBe(400);
    expect(result.body.ok).toBe(false);
    expect(result.body.error).toContain("No valid image URLs");
  });
});

describe("runSmartDraftScan - Dropbox path", () => {
  it("returns 400 when refresh token missing", async () => {
    mockStoreGet.mockResolvedValue(null);

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos" });

    expect(result.status).toBe(400);
    expect(result.body.error).toContain("Connect Dropbox");
  });

  it("returns empty response when folder has no files", async () => {
    mockDropboxList.mockResolvedValue([]);

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos" });

    expect(result.status).toBe(200);
    expect(result.body.count).toBe(0);
    expect(result.body.warnings).toContain("No images found in folder.");
    expect(result.body.stagedUrls).toEqual([]);
  });

  it("uses cache when signature matches", async () => {
    const files = [makeIngested({ id: "1", name: "a.jpg" })];
    mockDropboxList.mockResolvedValue(files);
    const signature = createHash("sha256")
      .update(JSON.stringify(files.map((f) => ({ id: f.id, name: f.name }))))
      .digest("hex")
      .slice(0, 16);
    mockGetCached.mockResolvedValue({
      signature,
      groups: [{ images: [files[0].stagedUrl], name: "cached" }],
      warnings: ["cached"],
      imageInsights: { [files[0].stagedUrl]: { url: files[0].stagedUrl, role: "front" } },
    });

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos" });

    expect(result.body.cached).toBe(true);
    expect(result.body.groups[0].folder).toBe("/Photos");
    expect(mockRunAnalysis).not.toHaveBeenCalled();
  });

  it("builds fallback groups when sanitize removes URLs", async () => {
    const files = [makeIngested({ name: "a.jpg", stagedUrl: "https://r2/a.jpg" })];
    mockDropboxList.mockResolvedValue(files);
    mockSanitizeUrls.mockReturnValue([]);

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos" });

    expect(result.status).toBe(200);
    expect(result.body.warnings).toContain("No usable image URLs; generated fallback groups.");
    expect(result.body.groups.length).toBeGreaterThan(0);
    expect(mockRunAnalysis).not.toHaveBeenCalled();
  });

  it("rejects when quota not allowed for Dropbox path", async () => {
    const files = [makeIngested({ stagedUrl: "https://r2/a.jpg" })];
    mockDropboxList.mockResolvedValue(files);
    mockCanConsumeImages.mockResolvedValueOnce(false);

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos" });

    expect(result.status).toBe(429);
    expect(mockRunAnalysis).not.toHaveBeenCalled();
  });

  it("processes Dropbox files and caches results", async () => {
    const files = [makeIngested({ id: "10", name: "hero.jpg", stagedUrl: "https://r2/hero.jpg" })];
    mockDropboxList.mockResolvedValue(files);
    mockSanitizeUrls.mockReturnValue(files.map((f) => f.stagedUrl));
    mockCanConsumeImages.mockResolvedValueOnce(true);
    mockUrlKey.mockImplementation((url: string) => url);
    mockRunAnalysis.mockResolvedValue({
      groups: [{ groupId: "g1", images: [files[0].stagedUrl], heroUrl: files[0].stagedUrl }],
      imageInsights: { [files[0].stagedUrl]: { url: files[0].stagedUrl, role: "front" } },
      warnings: ["warn"],
      orphans: [],
    });

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos" });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.groups?.[0]?.images).toEqual([files[0].stagedUrl]);
  });
});

describe("runSmartDraftScan - validation", () => {
  it("requires either folder or stagedUrls", async () => {
    const result = await runSmartDraftScan({ userId: "u1" });
    expect(result.status).toBe(400);
    expect(result.body.ok).toBe(false);
  });

  it("rejects when both folder and stagedUrls provided", async () => {
    const result = await runSmartDraftScan({ userId: "u1", folder: "/a", stagedUrls: ["https://x"] });
    expect(result.status).toBe(400);
    expect(result.body.ok).toBe(false);
  });
});

describe("runSmartDraftScan - role reconciliation", () => {
  it("reassigns orphans, hydrates display URLs, and reconciles roles", async () => {
    const files = [
      makeIngested({ id: "front", name: "front.jpg", stagedUrl: "https://cdn/front.jpg" }),
      makeIngested({ id: "back", name: "back.jpg", stagedUrl: "https://cdn/back.jpg" }),
    ];

    mockDropboxList.mockResolvedValue(files);
    mockSanitizeUrls.mockReturnValue(files.map((f) => f.stagedUrl));

    // Use stable url keys so displayUrl hydration succeeds
    mockUrlKey.mockImplementation((url: string) => url);

    mockRunAnalysis.mockResolvedValue({
      groups: [
        {
          groupId: "g1",
          images: [files[0].stagedUrl],
          heroUrl: files[0].stagedUrl,
        },
      ],
      imageInsights: {
        [files[0].stagedUrl]: {
          url: files[0].stagedUrl,
          role: "front",
          hasVisibleText: true,
          visualDescription: "Front panel with centered brand text",
          evidenceTriggers: ["brand logo"],
        },
        [files[1].stagedUrl]: {
          url: files[1].stagedUrl,
          role: "back",
          hasVisibleText: false,
          visualDescription: "Nutrition facts and barcode on pouch back",
          evidenceTriggers: ["nutrition facts"],
        },
      },
      warnings: [],
      orphans: [],
    });

    mockReassignOrphans.mockReturnValue([
      {
        orphanKey: files[1].stagedUrl,
        matchedGroupId: "g1",
        confidence: 0.92,
        reason: "back panel matches pouch color and triggers",
      },
    ]);

    mockComputeRoleConfidenceBatch.mockReturnValue(
      new Map<string, any>([
        [files[0].stagedUrl, { role: "front", confidence: 0.91, flags: [] }],
        [files[1].stagedUrl, { role: "back", confidence: 0.72, flags: [] }],
      ])
    );

    mockCrossCheckGroupRoles.mockReturnValue({
      groupId: "g1",
      corrections: [
        {
          imageKey: files[1].stagedUrl,
          originalRole: "back",
          correctedRole: "front",
          reason: "role confidence mismatch",
        },
      ],
    });

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos" });

    expect(result.status).toBe(200);
    expect(result.body.groups?.[0]?.images).toContain(files[0].stagedUrl);
    expect(mockReassignOrphans).toHaveBeenCalled();
    expect(mockCrossCheckGroupRoles).toHaveBeenCalled();
    expect(mockFinalizeDisplayUrls).toHaveBeenCalled();

    const insights = result.body.imageInsights || {};
    expect(insights[files[0].stagedUrl]?.displayUrl).toBe(files[0].stagedUrl);
    expect(insights[files[1].stagedUrl]?.role).toBe("front");
    expect((result.body.orphans || []).length).toBe(0);
  });
});

describe("runSmartDraftScan - force refresh", () => {
  it("bypasses cache when force=true for Dropbox path", async () => {
    const files = [makeIngested({ id: "1", name: "a.jpg", stagedUrl: "https://r2/a.jpg" })];
    mockDropboxList.mockResolvedValue(files);
    
    // Set up cache that would normally be hit
    const signature = createHash("sha256")
      .update(JSON.stringify(files.map(f => ({ id: f.id, name: f.name }))))
      .digest("hex")
      .slice(0, 16);
    mockGetCached.mockResolvedValue({
      signature,
      groups: [{ images: [files[0].stagedUrl], brand: "CachedBrand" }],
      warnings: [],
      imageInsights: {},
    });

    mockSanitizeUrls.mockReturnValue(files.map((f) => f.stagedUrl));
    mockUrlKey.mockImplementation((url: string) => url);
    mockRunAnalysis.mockResolvedValue({
      groups: [{ groupId: "g1", images: [files[0].stagedUrl], heroUrl: files[0].stagedUrl, brand: "FreshBrand" }],
      imageInsights: { [files[0].stagedUrl]: { url: files[0].stagedUrl, role: "front" } },
      warnings: [],
      orphans: [],
    });

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos", force: true });

    expect(result.status).toBe(200);
    expect(result.body.cached).toBeFalsy();
    expect(mockRunAnalysis).toHaveBeenCalled();
    expect(mockSetCached).toHaveBeenCalled();
  });

  it("bypasses cache when force=true for staged URLs", async () => {
    const urls = ["https://cdn/a.jpg", "https://cdn/b.jpg"];
    const signature = createHash("sha256").update(JSON.stringify(urls.sort())).digest("hex").slice(0, 16);
    
    mockGetCached.mockResolvedValue({
      signature,
      groups: [{ images: ["https://cdn/a.jpg"], brand: "Cached" }],
      warnings: [],
      imageInsights: {},
    });

    mockSanitizeUrls.mockReturnValue(urls);
    mockUrlKey.mockImplementation((url: string) => url);
    mockRunAnalysis.mockResolvedValue({
      groups: [{ groupId: "g1", images: urls, heroUrl: urls[0] }],
      imageInsights: {},
      warnings: [],
      orphans: [],
    });

    const result = await runSmartDraftScan({ userId: "u1", stagedUrls: urls, force: true });

    expect(result.status).toBe(200);
    expect(result.body.cached).toBeFalsy();
    expect(mockRunAnalysis).toHaveBeenCalled();
  });
});

describe("runSmartDraftScan - debug mode", () => {
  it("bypasses cache when debug=true (Dropbox)", async () => {
    const files = [makeIngested({ id: "1", name: "a.jpg", stagedUrl: "https://r2/a.jpg" })];
    mockDropboxList.mockResolvedValue(files);
    
    const signature = createHash("sha256")
      .update(JSON.stringify(files.map(f => ({ id: f.id, name: f.name }))))
      .digest("hex")
      .slice(0, 16);
    mockGetCached.mockResolvedValue({
      signature,
      groups: [{ images: [files[0].stagedUrl], brand: "CachedBrand" }],
      warnings: [],
      imageInsights: {},
    });

    mockSanitizeUrls.mockReturnValue(files.map((f) => f.stagedUrl));
    mockUrlKey.mockImplementation((url: string) => url);
    mockRunAnalysis.mockResolvedValue({
      groups: [{ groupId: "g1", images: [files[0].stagedUrl], heroUrl: files[0].stagedUrl }],
      imageInsights: {},
      warnings: [],
      orphans: [],
    });

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos", debug: true });

    expect(result.status).toBe(200);
    expect(result.body.cached).toBeFalsy();
    expect(mockRunAnalysis).toHaveBeenCalled();
    // Debug mode should skip quota check
    expect(mockCanConsumeImages).not.toHaveBeenCalled();
    expect(mockConsumeImages).not.toHaveBeenCalled();
  });

  it("bypasses cache when debug='1' string (staged URLs)", async () => {
    const urls = ["https://cdn/a.jpg"];
    const signature = createHash("sha256").update(JSON.stringify(urls.sort())).digest("hex").slice(0, 16);
    
    mockGetCached.mockResolvedValue({
      signature,
      groups: [{ images: urls, brand: "Cached" }],
      warnings: [],
      imageInsights: {},
    });

    mockSanitizeUrls.mockReturnValue(urls);
    mockUrlKey.mockImplementation((url: string) => url);
    mockRunAnalysis.mockResolvedValue({
      groups: [{ groupId: "g1", images: urls, heroUrl: urls[0] }],
      imageInsights: {},
      warnings: [],
      orphans: [],
    });

    const result = await runSmartDraftScan({ userId: "u1", stagedUrls: urls, debug: "1" });

    expect(result.status).toBe(200);
    expect(mockRunAnalysis).toHaveBeenCalled();
    expect(mockCanConsumeImages).not.toHaveBeenCalled();
  });
});

describe("runSmartDraftScan - limit handling", () => {
  it("respects limit parameter for Dropbox files", async () => {
    const files = Array.from({ length: 50 }, (_, i) =>
      makeIngested({ id: `${i}`, name: `img${i}.jpg`, stagedUrl: `https://r2/img${i}.jpg` })
    );
    mockDropboxList.mockResolvedValue(files);
    mockSanitizeUrls.mockImplementation((urls: string[]) => urls);
    mockUrlKey.mockImplementation((url: string) => url);
    mockRunAnalysis.mockResolvedValue({
      groups: [],
      imageInsights: {},
      warnings: [],
      orphans: [],
    });

    await runSmartDraftScan({ userId: "u1", folder: "/Photos", limit: 10 });

    // The sanitizeUrls should receive at most 10 URLs
    const sanitizeCall = mockSanitizeUrls.mock.calls[0]?.[0] as string[];
    expect(sanitizeCall?.length).toBeLessThanOrEqual(10);
  });

  it("respects limit parameter for staged URLs", async () => {
    const urls = Array.from({ length: 50 }, (_, i) => `https://cdn/img${i}.jpg`);
    mockSanitizeUrls.mockImplementation((u: string[]) => u);
    mockUrlKey.mockImplementation((url: string) => url);
    mockRunAnalysis.mockResolvedValue({
      groups: [],
      imageInsights: {},
      warnings: [],
      orphans: [],
    });

    await runSmartDraftScan({ userId: "u1", stagedUrls: urls, limit: 5 });

    // Should limit to 5 URLs
    const sanitizeCall = mockSanitizeUrls.mock.calls[0]?.[0] as string[];
    expect(sanitizeCall?.length).toBe(5);
  });

  it("uses MAX_IMAGES when limit is invalid", async () => {
    const urls = Array.from({ length: 5 }, (_, i) => `https://cdn/img${i}.jpg`);
    mockSanitizeUrls.mockImplementation((u: string[]) => u);
    mockUrlKey.mockImplementation((url: string) => url);
    mockRunAnalysis.mockResolvedValue({
      groups: [],
      imageInsights: {},
      warnings: [],
      orphans: [],
    });

    await runSmartDraftScan({ userId: "u1", stagedUrls: urls, limit: -5 });

    // Should process all URLs when limit is invalid
    const sanitizeCall = mockSanitizeUrls.mock.calls[0]?.[0] as string[];
    expect(sanitizeCall?.length).toBe(5);
  });
});

describe("runSmartDraftScan - skipQuota handling", () => {
  it("skips quota check when skipQuota=true (Dropbox)", async () => {
    const files = [makeIngested({ id: "1", name: "a.jpg", stagedUrl: "https://r2/a.jpg" })];
    mockDropboxList.mockResolvedValue(files);
    mockSanitizeUrls.mockReturnValue(files.map((f) => f.stagedUrl));
    mockUrlKey.mockImplementation((url: string) => url);
    mockRunAnalysis.mockResolvedValue({
      groups: [{ groupId: "g1", images: [files[0].stagedUrl], heroUrl: files[0].stagedUrl }],
      imageInsights: {},
      warnings: [],
      orphans: [],
    });

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos", skipQuota: true });

    expect(result.status).toBe(200);
    // canConsumeImages may be called but consumeImages should be skipped
    expect(mockConsumeImages).not.toHaveBeenCalled();
  });
});

describe("runSmartDraftScan - error handling", () => {
  it("returns 500 when Dropbox list throws", async () => {
    mockDropboxList.mockRejectedValue(new Error("Dropbox API failure"));

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos" });

    expect(result.status).toBe(500);
    expect(result.body.ok).toBe(false);
    expect(result.body.error).toContain("Dropbox API failure");
  });

  it("returns 500 when analysis throws", async () => {
    const files = [makeIngested({ id: "1", name: "a.jpg", stagedUrl: "https://r2/a.jpg" })];
    mockDropboxList.mockResolvedValue(files);
    mockSanitizeUrls.mockReturnValue(files.map((f) => f.stagedUrl));
    mockRunAnalysis.mockRejectedValue(new Error("Vision API failure"));

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos" });

    expect(result.status).toBe(500);
    expect(result.body.ok).toBe(false);
    expect(result.body.error).toContain("Vision API failure");
  });
});

describe("runSmartDraftScan - imageInsights processing", () => {
  it("processes array-style imageInsights from analysis", async () => {
    const files = [makeIngested({ id: "1", name: "a.jpg", stagedUrl: "https://r2/a.jpg" })];
    mockDropboxList.mockResolvedValue(files);
    mockSanitizeUrls.mockReturnValue(files.map((f) => f.stagedUrl));
    mockUrlKey.mockImplementation((url: string) => url);
    
    // Return imageInsights as array (alternative format)
    mockRunAnalysis.mockResolvedValue({
      groups: [{ groupId: "g1", images: [files[0].stagedUrl], heroUrl: files[0].stagedUrl }],
      imageInsights: [
        { url: files[0].stagedUrl, role: "front", hasVisibleText: true },
      ],
      warnings: [],
      orphans: [],
    });

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos" });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("handles missing imageInsights gracefully", async () => {
    const files = [makeIngested({ id: "1", name: "a.jpg", stagedUrl: "https://r2/a.jpg" })];
    mockDropboxList.mockResolvedValue(files);
    mockSanitizeUrls.mockReturnValue(files.map((f) => f.stagedUrl));
    mockUrlKey.mockImplementation((url: string) => url);
    
    mockRunAnalysis.mockResolvedValue({
      groups: [{ groupId: "g1", images: [files[0].stagedUrl], heroUrl: files[0].stagedUrl }],
      imageInsights: undefined,
      warnings: [],
      orphans: [],
    });

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos" });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
  });
});

describe("runSmartDraftScan - vision groups processing", () => {
  it("deduplicates images within groups", async () => {
    const urls = ["https://cdn/a.jpg", "https://cdn/b.jpg"];
    mockSanitizeUrls.mockReturnValue(urls);
    mockUrlKey.mockImplementation((url: string) => url);
    
    // Return group with duplicate images
    mockRunAnalysis.mockResolvedValue({
      groups: [{ 
        groupId: "g1", 
        images: [urls[0], urls[0], urls[1], urls[1]], // Duplicates
        heroUrl: urls[0] 
      }],
      imageInsights: {},
      warnings: [],
      orphans: [],
    });

    const result = await runSmartDraftScan({ userId: "u1", stagedUrls: urls });

    expect(result.status).toBe(200);
    // Images should be deduplicated
    const groupImages = result.body.groups?.[0]?.images || [];
    expect(groupImages.length).toBe(2);
  });

  it("hydrates heroDisplayUrl and backDisplayUrl from httpsByKey", async () => {
    const urls = ["https://cdn/front.jpg", "https://cdn/back.jpg"];
    mockSanitizeUrls.mockReturnValue(urls);
    mockUrlKey.mockImplementation((url: string) => url);
    
    mockRunAnalysis.mockResolvedValue({
      groups: [{ 
        groupId: "g1", 
        images: urls,
        heroUrl: urls[0],
        backUrl: urls[1]
      }],
      imageInsights: {},
      warnings: [],
      orphans: [],
    });

    const result = await runSmartDraftScan({ userId: "u1", stagedUrls: urls });

    expect(result.status).toBe(200);
    const group = result.body.groups?.[0];
    expect(group?.heroDisplayUrl).toBe(urls[0]);
    expect(group?.backDisplayUrl).toBe(urls[1]);
  });
});
