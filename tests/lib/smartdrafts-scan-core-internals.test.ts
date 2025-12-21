/**
 * Tests for internal functions exported via _testExports
 * These test the helper functions directly without mocking the full scan flow
 */

import { jest } from "@jest/globals";

// Mock all external dependencies BEFORE importing the module under test
jest.mock("node-fetch");
jest.mock("../../src/config.js", () => ({
  STRICT_TWO_ONLY: false,
  USE_CLIP: false,
  USE_NEW_SORTER: false,
  USE_ROLE_SORTING: false,
}));
jest.mock("../../src/utils/displayUrl.js", () => ({
  makeDisplayUrl: jest.fn((url: string) => url),
}));
jest.mock("../../src/utils/finalizeDisplay.js", () => ({
  finalizeDisplayUrls: jest.fn(),
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
  computeRoleConfidenceBatch: jest.fn(() => new Map()),
  crossCheckGroupRoles: jest.fn(() => ({ groupId: "", corrections: [] })),
}));
jest.mock("../../src/utils/urlKey.js", () => ({ 
  urlKey: jest.fn((url: string) => `key-${url}`) 
}));
jest.mock("../../src/utils/urlSanitize.js", () => ({ 
  sanitizeInsightUrl: jest.fn((url: string) => url) 
}));
jest.mock("../../src/lib/_auth.js", () => ({
  userScopedKey: jest.fn((user: string, key: string) => `${user}:${key}`),
}));
jest.mock("../../src/lib/_blobs.js", () => ({ 
  tokensStore: jest.fn(() => ({ get: jest.fn() })) 
}));
jest.mock("../../src/lib/analyze-core.js", () => ({ 
  runAnalysis: jest.fn(() => ({ groups: [], imageInsights: {}, warnings: [], orphans: [] })) 
}));
jest.mock("../../src/lib/clip-client-split.js", () => ({
  clipImageEmbedding: jest.fn(async () => [0.1, 0.2, 0.3]),
  clipTextEmbedding: jest.fn(async () => [0.1, 0.2, 0.3]),
  clipProviderInfo: jest.fn(() => ({ provider: "mock", textBase: "t", imageBase: "i" })),
  cosine: jest.fn(() => 0.5),
}));
jest.mock("../../src/lib/merge.js", () => ({
  sanitizeUrls: jest.fn((urls: string[]) => urls),
  toDirectDropbox: jest.fn((url: string) => url),
}));
jest.mock("../../src/lib/quota.js", () => ({
  canConsumeImages: jest.fn(() => true),
  consumeImages: jest.fn(),
}));
jest.mock("../../src/lib/smartdrafts-store.js", () => ({
  getCachedSmartDraftGroups: jest.fn(() => null),
  setCachedSmartDraftGroups: jest.fn(),
  makeCacheKey: jest.fn(() => "cache-key"),
}));
jest.mock("../../src/lib/sorter/frontBackStrict.js", () => ({
  frontBackStrict: jest.fn((imgs: any[]) => imgs),
}));
jest.mock("../../src/ingestion/dropbox.js", () => ({
  DropboxAdapter: { list: jest.fn(() => []) },
}));
jest.mock("../../src/lib/orphan-reassignment.js", () => ({
  reassignOrphans: jest.fn(() => []),
}));

// Now import the module after mocks are set up
let _testExports: any;

beforeAll(async () => {
  const module = await import("../../src/lib/smartdrafts-scan-core.js");
  _testExports = module._testExports;
});


// =============================================================================
// jsonEnvelope tests
// =============================================================================
describe('jsonEnvelope', () => {
  it('should create a response with status 200 and body', () => {
    const { jsonEnvelope } = _testExports;
    const body = { ok: true, groups: [], orphans: [], totalImages: 0 };
    const result = jsonEnvelope(200, body as any);
    expect(result.status).toBe(200);
    expect(result.body).toEqual(body);
  });

  it('should create a response with status 500 and error', () => {
    const { jsonEnvelope } = _testExports;
    const body = { ok: false, error: 'Something went wrong' };
    const result = jsonEnvelope(500, body as any);
    expect(result.status).toBe(500);
    expect(result.body.error).toBe('Something went wrong');
  });

  it('should create a response with status 400', () => {
    const { jsonEnvelope } = _testExports;
    const body = { ok: false, error: 'Bad request' };
    const result = jsonEnvelope(400, body as any);
    expect(result.status).toBe(400);
  });
});

// =============================================================================
// basenameFrom tests
// =============================================================================
describe('basenameFrom', () => {
  it('should extract filename from URL', () => {
    expect(basenameFrom('https://example.com/images/photo.jpg')).toBe('photo.jpg');
  });

  it('should extract filename from path', () => {
    expect(basenameFrom('/folder/subfolder/image.png')).toBe('image.png');
  });

  it('should handle URLs with query strings', () => {
    expect(basenameFrom('https://example.com/file.jpg?width=100')).toBe('file.jpg');
  });

  it('should handle empty string', () => {
    expect(basenameFrom('')).toBe('');
  });

  it('should handle URLs ending with slash', () => {
    expect(basenameFrom('https://example.com/folder/')).toBe('');
  });

  it('should handle simple filename', () => {
    expect(basenameFrom('test.jpg')).toBe('test.jpg');
  });

  it('should handle URL with only domain', () => {
    expect(basenameFrom('https://example.com')).toBe('example.com');
  });

  it('should handle deeply nested paths', () => {
    expect(basenameFrom('/a/b/c/d/e/file.webp')).toBe('file.webp');
  });

  it('should handle whitespace around URL', () => {
    expect(basenameFrom('  https://example.com/image.jpg  ')).toBe('image.jpg');
  });

  it('should return original on error', () => {
    // Pass something that might cause issues but gracefully returns
    expect(basenameFrom('simple')).toBe('simple');
  });

  it('should handle null-like empty value', () => {
    expect(basenameFrom('')).toBe('');
  });
});

// =============================================================================
// isImage tests
// =============================================================================
describe('isImage', () => {
  it('should return true for .jpg files', () => {
    expect(isImage('photo.jpg')).toBe(true);
  });

  it('should return true for .jpeg files', () => {
    expect(isImage('photo.jpeg')).toBe(true);
  });

  it('should return true for .png files', () => {
    expect(isImage('image.png')).toBe(true);
  });

  it('should return true for .gif files', () => {
    expect(isImage('animation.gif')).toBe(true);
  });

  it('should return true for .webp files', () => {
    expect(isImage('modern.webp')).toBe(true);
  });

  it('should return true for .tiff files', () => {
    expect(isImage('scan.tiff')).toBe(true);
  });

  it('should return true for .tif files', () => {
    expect(isImage('scan.tif')).toBe(true);
  });

  it('should return true for .bmp files', () => {
    expect(isImage('bitmap.bmp')).toBe(true);
  });

  it('should return true for uppercase extensions', () => {
    expect(isImage('PHOTO.JPG')).toBe(true);
    expect(isImage('IMAGE.PNG')).toBe(true);
  });

  it('should return true for mixed case extensions', () => {
    expect(isImage('photo.JpG')).toBe(true);
  });

  it('should return false for non-image files', () => {
    expect(isImage('document.pdf')).toBe(false);
    expect(isImage('script.js')).toBe(false);
    expect(isImage('data.json')).toBe(false);
    expect(isImage('readme.txt')).toBe(false);
  });

  it('should return false for files without extension', () => {
    expect(isImage('imagefile')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isImage('')).toBe(false);
  });

  it('should handle dots in filename', () => {
    expect(isImage('my.photo.backup.jpg')).toBe(true);
    expect(isImage('my.photo.backup.txt')).toBe(false);
  });
});

// =============================================================================
// folderPath tests
// =============================================================================
describe('folderPath', () => {
  it('should extract folder path from entry', () => {
    const entry = { path_display: '/Photos/Products/image.jpg' } as any;
    expect(folderPath(entry)).toBe('Photos/Products');
  });

  it('should use path_lower as fallback', () => {
    const entry = { path_lower: '/photos/products/image.jpg' } as any;
    expect(folderPath(entry)).toBe('photos/products');
  });

  it('should prefer path_display over path_lower', () => {
    const entry = {
      path_display: '/Photos/Products/Image.jpg',
      path_lower: '/photos/products/image.jpg',
    } as any;
    expect(folderPath(entry)).toBe('Photos/Products');
  });

  it('should handle root level files', () => {
    const entry = { path_display: '/image.jpg' } as any;
    expect(folderPath(entry)).toBe('');
  });

  it('should handle empty path', () => {
    const entry = { path_display: '' } as any;
    expect(folderPath(entry)).toBe('');
  });

  it('should handle missing path properties', () => {
    const entry = {} as any;
    expect(folderPath(entry)).toBe('');
  });

  it('should handle deeply nested paths', () => {
    const entry = { path_display: '/A/B/C/D/E/file.jpg' } as any;
    expect(folderPath(entry)).toBe('A/B/C/D/E');
  });

  it('should handle single folder depth', () => {
    const entry = { path_display: '/Products/item.png' } as any;
    expect(folderPath(entry)).toBe('Products');
  });
});

// =============================================================================
// makeSignature tests
// =============================================================================
describe('makeSignature', () => {
  it('should create a consistent hash for same files', () => {
    const files = [
      { id: 'file1', rev: 'rev1', server_modified: '2024-01-01', size: 100 },
      { id: 'file2', rev: 'rev2', server_modified: '2024-01-02', size: 200 },
    ] as any[];
    
    const sig1 = makeSignature(files);
    const sig2 = makeSignature(files);
    expect(sig1).toBe(sig2);
  });

  it('should create different hash for different files', () => {
    const files1 = [{ id: 'file1', rev: 'rev1' }] as any[];
    const files2 = [{ id: 'file2', rev: 'rev2' }] as any[];
    
    expect(makeSignature(files1)).not.toBe(makeSignature(files2));
  });

  it('should handle empty array', () => {
    const sig = makeSignature([]);
    expect(sig).toBeTruthy();
    expect(typeof sig).toBe('string');
  });

  it('should be order-independent (sorted internally)', () => {
    const files1 = [
      { id: 'a', path_lower: '/a.jpg' },
      { id: 'b', path_lower: '/b.jpg' },
    ] as any[];
    const files2 = [
      { id: 'b', path_lower: '/b.jpg' },
      { id: 'a', path_lower: '/a.jpg' },
    ] as any[];
    
    expect(makeSignature(files1)).toBe(makeSignature(files2));
  });

  it('should use path_lower when id is missing', () => {
    const files = [{ path_lower: '/photos/image.jpg', rev: 'r1' }] as any[];
    const sig = makeSignature(files);
    expect(sig).toBeTruthy();
    expect(sig.length).toBe(40); // SHA-1 hex length
  });

  it('should handle missing properties gracefully', () => {
    const files = [{ name: 'test.jpg' }] as any[];
    const sig = makeSignature(files);
    expect(sig).toBeTruthy();
  });
});

// =============================================================================
// buildFallbackGroups tests
// =============================================================================
describe('buildFallbackGroups', () => {
  it('should group files by folder', () => {
    const files = [
      { entry: { path_display: '/Products/A/image1.jpg', name: 'image1.jpg' }, url: 'http://example.com/1.jpg' },
      { entry: { path_display: '/Products/A/image2.jpg', name: 'image2.jpg' }, url: 'http://example.com/2.jpg' },
      { entry: { path_display: '/Products/B/image3.jpg', name: 'image3.jpg' }, url: 'http://example.com/3.jpg' },
    ] as any[];

    const groups = buildFallbackGroups(files);
    expect(groups.length).toBe(2);
    expect(groups.some(g => g.folder === 'Products/A')).toBe(true);
    expect(groups.some(g => g.folder === 'Products/B')).toBe(true);
  });

  it('should limit images to 12 per group', () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      entry: { path_display: `/Products/folder/image${i}.jpg`, name: `image${i}.jpg` },
      url: `http://example.com/${i}.jpg`,
    })) as any[];

    const groups = buildFallbackGroups(files);
    expect(groups.length).toBe(1);
    expect(groups[0].images.length).toBe(12);
  });

  it('should handle root level files', () => {
    const files = [
      { entry: { path_display: '/image.jpg', name: 'image.jpg' }, url: 'http://example.com/root.jpg' },
    ] as any[];

    const groups = buildFallbackGroups(files);
    expect(groups.length).toBe(1);
    expect(groups[0].folder).toBe('');
  });

  it('should sort files by name within group', () => {
    const files = [
      { entry: { path_display: '/Products/c.jpg', name: 'c.jpg' }, url: 'http://example.com/c.jpg' },
      { entry: { path_display: '/Products/a.jpg', name: 'a.jpg' }, url: 'http://example.com/a.jpg' },
      { entry: { path_display: '/Products/b.jpg', name: 'b.jpg' }, url: 'http://example.com/b.jpg' },
    ] as any[];

    const groups = buildFallbackGroups(files);
    expect(groups[0].images[0]).toBe('http://example.com/a.jpg');
    expect(groups[0].images[1]).toBe('http://example.com/b.jpg');
    expect(groups[0].images[2]).toBe('http://example.com/c.jpg');
  });

  it('should set _fallback flag to true', () => {
    const files = [
      { entry: { path_display: '/Test/image.jpg', name: 'image.jpg' }, url: 'http://example.com/1.jpg' },
    ] as any[];

    const groups = buildFallbackGroups(files);
    expect(groups[0]._fallback).toBe(true);
  });

  it('should set low confidence (0.1)', () => {
    const files = [
      { entry: { path_display: '/Test/image.jpg', name: 'image.jpg' }, url: 'http://example.com/1.jpg' },
    ] as any[];

    const groups = buildFallbackGroups(files);
    expect(groups[0].confidence).toBe(0.1);
  });

  it('should use folder name as product name', () => {
    const files = [
      { entry: { path_display: '/Products/SuperWidget/image.jpg', name: 'image.jpg' }, url: 'http://example.com/1.jpg' },
    ] as any[];

    const groups = buildFallbackGroups(files);
    expect(groups[0].product).toBe('SuperWidget');
    expect(groups[0].name).toBe('SuperWidget');
  });

  it('should generate unique groupId', () => {
    const files = [
      { entry: { path_display: '/A/img.jpg', name: 'img.jpg' }, url: 'http://example.com/a.jpg' },
      { entry: { path_display: '/B/img.jpg', name: 'img.jpg' }, url: 'http://example.com/b.jpg' },
    ] as any[];

    const groups = buildFallbackGroups(files);
    expect(groups[0].groupId).not.toBe(groups[1].groupId);
    expect(groups[0].groupId.startsWith('fallback_')).toBe(true);
    expect(groups[1].groupId.startsWith('fallback_')).toBe(true);
  });

  it('should handle empty files array', () => {
    const groups = buildFallbackGroups([]);
    expect(groups).toEqual([]);
  });
});

// =============================================================================
// mapLimit tests
// =============================================================================
describe('mapLimit', () => {
  it('should process all items', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapLimit(items, 2, async (item) => item * 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it('should respect concurrency limit', async () => {
    let currentConcurrency = 0;
    let maxConcurrency = 0;
    
    const items = [1, 2, 3, 4, 5, 6];
    await mapLimit(items, 2, async (item) => {
      currentConcurrency++;
      maxConcurrency = Math.max(maxConcurrency, currentConcurrency);
      await new Promise(resolve => setTimeout(resolve, 10));
      currentConcurrency--;
      return item;
    });
    
    expect(maxConcurrency).toBeLessThanOrEqual(2);
  });

  it('should handle empty array', async () => {
    const results = await mapLimit([], 5, async (item) => item);
    expect(results).toEqual([]);
  });

  it('should handle single item', async () => {
    const results = await mapLimit([42], 3, async (item) => item + 1);
    expect(results).toEqual([43]);
  });

  it('should maintain order of results', async () => {
    const items = [3, 1, 4, 1, 5];
    const results = await mapLimit(items, 3, async (item, index) => {
      await new Promise(resolve => setTimeout(resolve, item * 5));
      return index;
    });
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it('should handle errors in iterator', async () => {
    const items = [1, 2, 3];
    await expect(
      mapLimit(items, 2, async (item) => {
        if (item === 2) throw new Error('Test error');
        return item;
      })
    ).rejects.toThrow('Test error');
  });

  it('should work with limit greater than items length', async () => {
    const items = [1, 2];
    const results = await mapLimit(items, 10, async (item) => item * 3);
    expect(results).toEqual([3, 6]);
  });

  it('should handle async iterator with mixed timing', async () => {
    const items = ['a', 'b', 'c'];
    const delays = [50, 10, 30];
    const results = await mapLimit(items, 2, async (item, index) => {
      await new Promise(resolve => setTimeout(resolve, delays[index]));
      return `${item}-done`;
    });
    expect(results).toEqual(['a-done', 'b-done', 'c-done']);
  });
});

// =============================================================================
// hydrateGroups tests
// =============================================================================
describe('hydrateGroups', () => {
  it('should add imageInsights to groups', () => {
    const groups = [
      { groupId: 'g1', images: ['http://example.com/1.jpg', 'http://example.com/2.jpg'] },
    ] as any[];
    const insightMap = new Map([
      ['http://example.com/1.jpg', { role: 'front', brand: 'TestBrand' }],
      ['http://example.com/2.jpg', { role: 'back', brand: 'TestBrand' }],
    ]);

    hydrateGroups(groups, insightMap);

    expect(groups[0].imageInsights).toHaveLength(2);
    expect(groups[0].imageInsights[0].role).toBe('front');
    expect(groups[0].imageInsights[1].role).toBe('back');
  });

  it('should handle missing insights gracefully', () => {
    const groups = [
      { groupId: 'g1', images: ['http://example.com/1.jpg', 'http://example.com/missing.jpg'] },
    ] as any[];
    const insightMap = new Map([
      ['http://example.com/1.jpg', { role: 'front' }],
    ]);

    hydrateGroups(groups, insightMap);

    expect(groups[0].imageInsights).toHaveLength(2);
    expect(groups[0].imageInsights[0].role).toBe('front');
    expect(groups[0].imageInsights[1]).toEqual({ url: 'http://example.com/missing.jpg' });
  });

  it('should handle empty groups array', () => {
    const groups: any[] = [];
    const insightMap = new Map();
    
    expect(() => hydrateGroups(groups, insightMap)).not.toThrow();
  });

  it('should handle groups with no images', () => {
    const groups = [{ groupId: 'g1', images: [] }] as any[];
    const insightMap = new Map();
    
    hydrateGroups(groups, insightMap);
    expect(groups[0].imageInsights).toEqual([]);
  });

  it('should preserve existing insight properties', () => {
    const groups = [
      { groupId: 'g1', images: ['http://example.com/1.jpg'] },
    ] as any[];
    const insightMap = new Map([
      ['http://example.com/1.jpg', { role: 'front', brand: 'TestBrand', product: 'TestProduct', confidence: 0.95 }],
    ]);

    hydrateGroups(groups, insightMap);

    expect(groups[0].imageInsights[0].brand).toBe('TestBrand');
    expect(groups[0].imageInsights[0].product).toBe('TestProduct');
    expect(groups[0].imageInsights[0].confidence).toBe(0.95);
  });
});

// =============================================================================
// hydrateOrphans tests
// =============================================================================
describe('hydrateOrphans', () => {
  it('should add insight data to orphan objects', () => {
    const orphans = [
      { url: 'http://example.com/orphan1.jpg' },
      { url: 'http://example.com/orphan2.jpg' },
    ] as any[];
    const insightMap = new Map([
      ['http://example.com/orphan1.jpg', { role: 'front', category: 'product' }],
      ['http://example.com/orphan2.jpg', { role: 'back', category: 'non-product' }],
    ]);

    hydrateOrphans(orphans, insightMap);

    expect(orphans[0].role).toBe('front');
    expect(orphans[0].category).toBe('product');
    expect(orphans[1].role).toBe('back');
    expect(orphans[1].category).toBe('non-product');
  });

  it('should handle missing insights', () => {
    const orphans = [{ url: 'http://example.com/unknown.jpg' }] as any[];
    const insightMap = new Map();

    hydrateOrphans(orphans, insightMap);

    expect(orphans[0].url).toBe('http://example.com/unknown.jpg');
    // Should not add undefined properties
  });

  it('should handle empty orphans array', () => {
    const orphans: any[] = [];
    const insightMap = new Map();
    
    expect(() => hydrateOrphans(orphans, insightMap)).not.toThrow();
  });

  it('should spread all insight properties onto orphan', () => {
    const orphans = [{ url: 'http://example.com/item.jpg' }] as any[];
    const insightMap = new Map([
      ['http://example.com/item.jpg', {
        role: 'front',
        brand: 'TestBrand',
        product: 'Widget',
        confidence: 0.8,
        claims: ['organic'],
      }],
    ]);

    hydrateOrphans(orphans, insightMap);

    expect(orphans[0].brand).toBe('TestBrand');
    expect(orphans[0].product).toBe('Widget');
    expect(orphans[0].claims).toEqual(['organic']);
  });
});

// =============================================================================
// buildPairwiseGroups tests
// =============================================================================
describe('buildPairwiseGroups', () => {
  it('should pair consecutive images', () => {
    const files = [
      { entry: { path_display: '/Products/1.jpg', name: '1.jpg' }, url: 'http://example.com/1.jpg' },
      { entry: { path_display: '/Products/2.jpg', name: '2.jpg' }, url: 'http://example.com/2.jpg' },
      { entry: { path_display: '/Products/3.jpg', name: '3.jpg' }, url: 'http://example.com/3.jpg' },
      { entry: { path_display: '/Products/4.jpg', name: '4.jpg' }, url: 'http://example.com/4.jpg' },
    ] as any[];

    const groups = buildPairwiseGroups(files);

    expect(groups.length).toBe(2);
    expect(groups[0].images).toHaveLength(2);
    expect(groups[1].images).toHaveLength(2);
  });

  it('should handle odd number of files (last file becomes singleton)', () => {
    const files = [
      { entry: { path_display: '/Products/1.jpg', name: '1.jpg' }, url: 'http://example.com/1.jpg' },
      { entry: { path_display: '/Products/2.jpg', name: '2.jpg' }, url: 'http://example.com/2.jpg' },
      { entry: { path_display: '/Products/3.jpg', name: '3.jpg' }, url: 'http://example.com/3.jpg' },
    ] as any[];

    const groups = buildPairwiseGroups(files);

    expect(groups.length).toBe(2);
    expect(groups[0].images).toHaveLength(2);
    expect(groups[1].images).toHaveLength(1);
  });

  it('should sort files by name before pairing', () => {
    const files = [
      { entry: { path_display: '/Products/c.jpg', name: 'c.jpg' }, url: 'http://example.com/c.jpg' },
      { entry: { path_display: '/Products/a.jpg', name: 'a.jpg' }, url: 'http://example.com/a.jpg' },
      { entry: { path_display: '/Products/b.jpg', name: 'b.jpg' }, url: 'http://example.com/b.jpg' },
      { entry: { path_display: '/Products/d.jpg', name: 'd.jpg' }, url: 'http://example.com/d.jpg' },
    ] as any[];

    const groups = buildPairwiseGroups(files);

    // After sorting: a, b, c, d -> pairs (a,b) and (c,d)
    expect(groups[0].images).toContain('http://example.com/a.jpg');
    expect(groups[0].images).toContain('http://example.com/b.jpg');
    expect(groups[1].images).toContain('http://example.com/c.jpg');
    expect(groups[1].images).toContain('http://example.com/d.jpg');
  });

  it('should handle empty files array', () => {
    const groups = buildPairwiseGroups([]);
    expect(groups).toEqual([]);
  });

  it('should handle single file', () => {
    const files = [
      { entry: { path_display: '/Products/only.jpg', name: 'only.jpg' }, url: 'http://example.com/only.jpg' },
    ] as any[];

    const groups = buildPairwiseGroups(files);

    expect(groups.length).toBe(1);
    expect(groups[0].images).toHaveLength(1);
  });

  it('should generate unique groupIds', () => {
    const files = [
      { entry: { path_display: '/P/1.jpg', name: '1.jpg' }, url: 'http://a.com/1.jpg' },
      { entry: { path_display: '/P/2.jpg', name: '2.jpg' }, url: 'http://a.com/2.jpg' },
      { entry: { path_display: '/P/3.jpg', name: '3.jpg' }, url: 'http://a.com/3.jpg' },
      { entry: { path_display: '/P/4.jpg', name: '4.jpg' }, url: 'http://a.com/4.jpg' },
    ] as any[];

    const groups = buildPairwiseGroups(files);
    const groupIds = groups.map(g => g.groupId);
    const uniqueIds = new Set(groupIds);
    expect(uniqueIds.size).toBe(groupIds.length);
  });

  it('should set _pairwise flag to true', () => {
    const files = [
      { entry: { path_display: '/P/a.jpg', name: 'a.jpg' }, url: 'http://example.com/a.jpg' },
      { entry: { path_display: '/P/b.jpg', name: 'b.jpg' }, url: 'http://example.com/b.jpg' },
    ] as any[];

    const groups = buildPairwiseGroups(files);
    expect(groups[0]._pairwise).toBe(true);
  });

  it('should use first image filename as product name', () => {
    const files = [
      { entry: { path_display: '/Products/Widget-Front.jpg', name: 'Widget-Front.jpg' }, url: 'http://example.com/wf.jpg' },
      { entry: { path_display: '/Products/Widget-Back.jpg', name: 'Widget-Back.jpg' }, url: 'http://example.com/wb.jpg' },
    ] as any[];

    const groups = buildPairwiseGroups(files);
    expect(groups[0].product).toBeTruthy();
    expect(typeof groups[0].product).toBe('string');
  });
});
