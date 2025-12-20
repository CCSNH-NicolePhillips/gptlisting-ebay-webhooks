import { jest } from "@jest/globals";

// Mock external dependencies
jest.mock("node-fetch");
jest.mock("../../src/config.js");
jest.mock("../../src/utils/displayUrl.js");
jest.mock("../../src/utils/finalizeDisplay.js");
import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
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
  computeRoleConfidenceBatch: jest.fn(() => []),
  crossCheckGroupRoles: jest.fn(() => []),
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
  mockCanConsumeImages.mockResolvedValue({ allowed: true });
  mockConsumeImages.mockResolvedValue(undefined);
  mockUrlKey.mockImplementation((url: string) => `key-${url}`);
  mockMakeDisplayUrl.mockImplementation((url: string) => url);
  mockFinalizeDisplayUrls.mockReturnValue(undefined as any);
  mockSanitizeInsightUrl.mockImplementation((url: string, fallback?: string) => url || fallback || "");
  mockDropboxList.mockResolvedValue([]);
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
      imageInsights: { "https://cdn/a.jpg": { role: "front" } },
    });

    const result = await runSmartDraftScan({ userId: "u1", stagedUrls: urls });

    expect(result.status).toBe(200);
    expect(result.body.cached).toBe(true);
    expect(mockRunAnalysis).not.toHaveBeenCalled();
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("rejects when quota blocks staged URLs", async () => {
    mockGetCached.mockResolvedValue(null);
    mockCanConsumeImages.mockResolvedValue({ allowed: false });

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
      imageInsights: { [files[0].stagedUrl]: { role: "front" } },
    });

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos" });

    expect(result.body.cached).toBe(true);
    expect(result.body.groups[0].folder).toBe("Photos");
    expect(mockRunAnalysis).not.toHaveBeenCalled();
  });

  it("builds fallback groups when sanitize removes URLs", async () => {
    const files = [makeIngested({ name: "a.jpg", stagedUrl: "https://r2/a.jpg" })];
    mockDropboxList.mockResolvedValue(files);
    mockSanitizeUrls.mockReturnValue([]);

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos" });

    expect(result.status).toBe(200);
    expect(result.body.warnings).toContain("No usable image URLs");
    expect(result.body.groups.length).toBeGreaterThan(0);
    expect(mockRunAnalysis).not.toHaveBeenCalled();
  });

  it("rejects when quota not allowed for Dropbox path", async () => {
    const files = [makeIngested({ stagedUrl: "https://r2/a.jpg" })];
    mockDropboxList.mockResolvedValue(files);
    mockCanConsumeImages.mockResolvedValue({ allowed: false });

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos" });

    expect(result.status).toBe(429);
    expect(mockRunAnalysis).not.toHaveBeenCalled();
  });

  it("processes Dropbox files and caches results", async () => {
    const files = [makeIngested({ id: "10", name: "hero.jpg", stagedUrl: "https://r2/hero.jpg" })];
    mockDropboxList.mockResolvedValue(files);
    mockSanitizeUrls.mockReturnValue(files.map((f) => f.stagedUrl));
    mockRunAnalysis.mockResolvedValue({
      groups: [{ groupId: "g1", images: [files[0].stagedUrl], heroUrl: files[0].stagedUrl }],
      imageInsights: { [files[0].stagedUrl]: { role: "front" } },
      warnings: ["warn"],
      orphans: [],
    });

    const result = await runSmartDraftScan({ userId: "u1", folder: "/Photos" });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.groups.length).toBe(1);
    expect(mockSetCached).toHaveBeenCalled();
    expect(mockFinalizeDisplayUrls).toHaveBeenCalled();
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
      expect(runAnalysis).toHaveBeenCalled();
