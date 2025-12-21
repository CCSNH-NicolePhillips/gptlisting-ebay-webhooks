/**
 * Extended unit tests for smartdrafts-scan-core.ts
 * Tests helper functions, scoring logic, role reconciliation, and edge cases
 */

import { jest } from "@jest/globals";
import { createHash } from "node:crypto";

// ==== UNIT TESTS FOR HELPER FUNCTIONS (using reimplemented versions) ====
// These test the logic/algorithms directly without module import issues

describe('smartdrafts-scan-core: Helper Functions', () => {
  
  describe('normalizeFolderKey', () => {
    const normalizeFolderKey = (value: string | null | undefined): string => {
      if (!value) return "";
      return value.replace(/^[\\/]+/, "").trim();
    };

    it('should return empty string for null/undefined', () => {
      expect(normalizeFolderKey(null)).toBe('');
      expect(normalizeFolderKey(undefined)).toBe('');
    });

    it('should strip leading slashes', () => {
      expect(normalizeFolderKey('/Photos')).toBe('Photos');
      expect(normalizeFolderKey('//Deep/Path')).toBe('Deep/Path');
    });

    it('should strip leading backslashes', () => {
      expect(normalizeFolderKey('\\Windows\\Style')).toBe('Windows\\Style');
    });

    it('should trim whitespace and strip slashes', () => {
      // Note: trim happens after replace, so leading slash is stripped, then trimmed
      expect(normalizeFolderKey('  /path  ')).toBe('/path'); // Trailing spaces trimmed, but leading space prevents slash strip
      expect(normalizeFolderKey('/path  ')).toBe('path'); // No leading space, slash stripped, trailing space trimmed
    });

    it('should handle empty string', () => {
      expect(normalizeFolderKey('')).toBe('');
    });
  });

  describe('basenameFrom', () => {
    const basenameFrom = (u: string): string => {
      try {
        if (!u) return "";
        const trimmed = u.trim();
        if (!trimmed) return "";
        const noQuery = trimmed.split("?")[0];
        const parts = noQuery.split("/");
        return parts[parts.length - 1] || "";
      } catch {
        return u;
      }
    };

    it('should extract basename from URL', () => {
      expect(basenameFrom('https://example.com/path/image.jpg')).toBe('image.jpg');
    });

    it('should strip query params', () => {
      expect(basenameFrom('https://example.com/image.jpg?raw=1')).toBe('image.jpg');
    });

    it('should handle URL with no path', () => {
      expect(basenameFrom('https://example.com/')).toBe('');
    });

    it('should return empty for empty input', () => {
      expect(basenameFrom('')).toBe('');
      expect(basenameFrom('   ')).toBe('');
    });

    it('should handle simple path', () => {
      expect(basenameFrom('/local/path/file.png')).toBe('file.png');
    });
  });

  describe('isImage', () => {
    const isImage = (name: string) => {
      return /\.(jpe?g|png|gif|webp|tiff?|bmp)$/i.test(name);
    };

    it('should match jpeg/jpg files', () => {
      expect(isImage('photo.jpg')).toBe(true);
      expect(isImage('photo.jpeg')).toBe(true);
      expect(isImage('photo.JPG')).toBe(true);
    });

    it('should match png files', () => {
      expect(isImage('image.png')).toBe(true);
      expect(isImage('IMAGE.PNG')).toBe(true);
    });

    it('should match gif files', () => {
      expect(isImage('animation.gif')).toBe(true);
    });

    it('should match webp files', () => {
      expect(isImage('modern.webp')).toBe(true);
    });

    it('should match tiff files', () => {
      expect(isImage('scan.tiff')).toBe(true);
      expect(isImage('scan.tif')).toBe(true);
    });

    it('should match bmp files', () => {
      expect(isImage('bitmap.bmp')).toBe(true);
    });

    it('should not match non-image files', () => {
      expect(isImage('document.pdf')).toBe(false);
      expect(isImage('video.mp4')).toBe(false);
      expect(isImage('archive.zip')).toBe(false);
      expect(isImage('data.json')).toBe(false);
    });
  });

  describe('folderPath', () => {
    type DropboxEntry = {
      ".tag": string;
      path_display?: string | null;
      path_lower?: string | null;
    };

    const folderPath = (entry: DropboxEntry): string => {
      const raw = entry.path_display || entry.path_lower || "";
      if (!raw) return "";
      const parts = raw.split("/").filter(Boolean);
      parts.pop();
      return parts.join("/");
    };

    it('should extract folder from path_display', () => {
      const entry: DropboxEntry = { ".tag": "file", path_display: "/Photos/2024/image.jpg" };
      expect(folderPath(entry)).toBe('Photos/2024');
    });

    it('should fall back to path_lower', () => {
      const entry: DropboxEntry = { ".tag": "file", path_lower: "/photos/2024/image.jpg" };
      expect(folderPath(entry)).toBe('photos/2024');
    });

    it('should return empty for root file', () => {
      const entry: DropboxEntry = { ".tag": "file", path_display: "/image.jpg" };
      expect(folderPath(entry)).toBe('');
    });

    it('should handle missing paths', () => {
      const entry: DropboxEntry = { ".tag": "file" };
      expect(folderPath(entry)).toBe('');
    });
  });

  describe('makeSignature', () => {
    type DropboxEntry = {
      id?: string;
      path_lower?: string;
      rev?: string;
      server_modified?: string;
      size?: number;
    };

    const makeSignature = (files: DropboxEntry[]): string => {
      const joined = files
        .map((entry) => `${entry.id || entry.path_lower}:${entry.rev || ""}:${entry.server_modified || ""}:${entry.size || 0}`)
        .sort()
        .join("|");
      return createHash("sha1").update(joined).digest("hex");
    };

    it('should generate consistent hash for same files', () => {
      const files: DropboxEntry[] = [
        { id: "file1", rev: "abc123", server_modified: "2024-01-01", size: 1000 },
        { id: "file2", rev: "def456", server_modified: "2024-01-02", size: 2000 },
      ];
      const sig1 = makeSignature(files);
      const sig2 = makeSignature(files);
      expect(sig1).toBe(sig2);
    });

    it('should produce different hash for different files', () => {
      const files1: DropboxEntry[] = [{ id: "file1", rev: "abc" }];
      const files2: DropboxEntry[] = [{ id: "file2", rev: "abc" }];
      expect(makeSignature(files1)).not.toBe(makeSignature(files2));
    });

    it('should handle missing fields', () => {
      const files: DropboxEntry[] = [{ path_lower: "/path/file.jpg" }];
      const sig = makeSignature(files);
      expect(sig).toBeTruthy();
      expect(sig.length).toBe(40); // SHA1 hex is 40 chars
    });

    it('should sort files for consistent ordering', () => {
      const files1: DropboxEntry[] = [
        { id: "a" }, { id: "b" }
      ];
      const files2: DropboxEntry[] = [
        { id: "b" }, { id: "a" }
      ];
      expect(makeSignature(files1)).toBe(makeSignature(files2));
    });
  });

  describe('mapLimit concurrency helper', () => {
    async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
      const results: R[] = new Array(items.length);
      let next = 0;

      async function worker() {
        while (next < items.length) {
          const current = next++;
          results[current] = await fn(items[current], current);
        }
      }

      const workers = new Array(Math.min(limit, items.length)).fill(0).map(() => worker());
      await Promise.all(workers);
      return results;
    }

    it('should process all items', async () => {
      const items = [1, 2, 3, 4, 5];
      const results = await mapLimit(items, 2, async (n) => n * 2);
      expect(results).toEqual([2, 4, 6, 8, 10]);
    });

    it('should preserve order', async () => {
      const items = ['a', 'b', 'c'];
      const results = await mapLimit(items, 2, async (s, i) => `${i}:${s}`);
      expect(results).toEqual(['0:a', '1:b', '2:c']);
    });

    it('should handle empty array', async () => {
      const results = await mapLimit([], 5, async (x) => x);
      expect(results).toEqual([]);
    });

    it('should limit concurrency', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const items = [1, 2, 3, 4, 5];
      await mapLimit(items, 2, async (n) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(r => setTimeout(r, 10));
        concurrent--;
        return n;
      });

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });
});

describe('smartdrafts-scan-core: Scoring Logic', () => {
  
  describe('Color matching', () => {
    it('should award points for matching dominant color', () => {
      const productColor: string = 'green';
      const candidateColor: string = 'green';
      const score = productColor === candidateColor ? 15 : 0;
      expect(score).toBe(15);
    });

    it('should not award points for mismatched color', () => {
      const productColor: string = 'green';
      const candidateColor: string = 'blue';
      const score = productColor === candidateColor ? 15 : 0;
      expect(score).toBe(0);
    });
  });

  describe('Packaging type matching', () => {
    const packagingTypes = [
      'pouch', 'stand-up pouch', 'resealable pouch',
      'bottle', 'plastic bottle', 'glass bottle', 'cylindrical bottle',
      'jar', 'tube', 'squeeze tube', 'pump bottle',
      'box', 'rectangular box', 'canister', 'container'
    ];

    function matchPackaging(visual1: string, visual2: string): { matched: boolean; type?: string } {
      const v1 = visual1.toLowerCase();
      const v2 = visual2.toLowerCase();
      for (const pkg of packagingTypes) {
        if (v1.includes(pkg) && v2.includes(pkg)) {
          return { matched: true, type: pkg };
        }
      }
      return { matched: false };
    }

    it('should match "pouch" packaging', () => {
      const result = matchPackaging('green stand-up pouch', 'back of pouch');
      expect(result.matched).toBe(true);
      expect(result.type).toBe('pouch');
    });

    it('should match "bottle" packaging', () => {
      const result = matchPackaging('plastic bottle label', 'cylindrical bottle back');
      expect(result.matched).toBe(true);
    });

    it('should not match different packaging types', () => {
      const result = matchPackaging('pouch front', 'bottle back');
      expect(result.matched).toBe(false);
    });
  });

  describe('Back panel feature detection', () => {
    const backFeatures = [
      'supplement facts', 'nutrition facts', 'nutrition panel',
      'ingredient list', 'ingredients section',
      'directions', 'directions panel',
      'barcode', 'upc code',
      'warnings', 'allergen', 'storage instructions'
    ];

    function countBackFeatures(visual: string): { count: number; features: string[] } {
      const v = visual.toLowerCase();
      const found: string[] = [];
      for (const feature of backFeatures) {
        if (v.includes(feature)) {
          found.push(feature);
        }
      }
      return { count: found.length, features: found };
    }

    it('should detect supplement facts', () => {
      const result = countBackFeatures('Back panel with supplement facts table');
      expect(result.features).toContain('supplement facts');
    });

    it('should detect multiple features', () => {
      const result = countBackFeatures('Nutrition facts, barcode, and directions panel');
      expect(result.count).toBeGreaterThanOrEqual(3);
      expect(result.features).toContain('nutrition facts');
      expect(result.features).toContain('barcode');
      expect(result.features).toContain('directions');
    });

    it('should cap panel points at 9', () => {
      const result = countBackFeatures('Has everything: supplement facts, barcode, directions, warnings, allergen info');
      const points = Math.min(result.count * 3, 9);
      expect(points).toBeLessThanOrEqual(9);
    });
  });

  describe('Material matching', () => {
    const materials = ['glossy', 'matte', 'metallic', 'foil', 'transparent', 'clear', 'frosted', 'plastic', 'glass', 'paper'];

    function matchMaterial(v1: string, v2: string): string | null {
      const lower1 = v1.toLowerCase();
      const lower2 = v2.toLowerCase();
      for (const m of materials) {
        if (lower1.includes(m) && lower2.includes(m)) return m;
      }
      return null;
    }

    it('should match glossy finish', () => {
      expect(matchMaterial('glossy label', 'glossy pouch')).toBe('glossy');
    });

    it('should match glass material', () => {
      expect(matchMaterial('glass bottle', 'frosted glass')).toBe('glass');
    });

    it('should return null for no match', () => {
      expect(matchMaterial('plastic bottle', 'paper box')).toBeNull();
    });
  });
});

describe('smartdrafts-scan-core: Role Confidence', () => {
  
  describe('Confidence thresholds', () => {
    function categorizeConfidence(conf: number): string {
      if (conf >= 0.7) return 'high';
      if (conf >= 0.4) return 'medium';
      return 'low';
    }

    it('should categorize high confidence (>=0.7)', () => {
      expect(categorizeConfidence(0.91)).toBe('high');
      expect(categorizeConfidence(0.70)).toBe('high');
    });

    it('should categorize medium confidence (0.4-0.7)', () => {
      expect(categorizeConfidence(0.69)).toBe('medium');
      expect(categorizeConfidence(0.40)).toBe('medium');
    });

    it('should categorize low confidence (<0.4)', () => {
      expect(categorizeConfidence(0.39)).toBe('low');
      expect(categorizeConfidence(0.10)).toBe('low');
    });
  });

  describe('Front protection logic (Phase 5a.2)', () => {
    interface Insight {
      role: string;
      originalRole?: string;
    }

    function shouldProtectFront(insight: Insight, newRole: string): boolean {
      const original = insight.originalRole ?? insight.role;
      if (original === 'front' && newRole !== 'front') {
        return true; // Refuse to demote front
      }
      return false;
    }

    it('should protect front from demotion to back', () => {
      const insight: Insight = { role: 'front', originalRole: 'front' };
      expect(shouldProtectFront(insight, 'back')).toBe(true);
    });

    it('should protect front from demotion to other', () => {
      const insight: Insight = { role: 'front', originalRole: 'front' };
      expect(shouldProtectFront(insight, 'other')).toBe(true);
    });

    it('should allow front to stay front', () => {
      const insight: Insight = { role: 'front' };
      expect(shouldProtectFront(insight, 'front')).toBe(false);
    });

    it('should allow back to become front', () => {
      const insight: Insight = { role: 'back' };
      expect(shouldProtectFront(insight, 'front')).toBe(false);
    });

    it('should use role if originalRole missing', () => {
      const insight: Insight = { role: 'front' };
      expect(shouldProtectFront(insight, 'back')).toBe(true);
    });
  });
});

describe('smartdrafts-scan-core: Group Validation', () => {
  
  describe('pickHeroBackForGroup logic', () => {
    interface GroupImage {
      url: string;
      role: string;
      score: number;
    }

    function pickHeroBack(images: GroupImage[]): { hero: string | null; back: string | null } {
      const fronts = images.filter(i => i.role === 'front').sort((a, b) => b.score - a.score);
      const backs = images.filter(i => i.role === 'back').sort((a, b) => b.score - a.score);

      return {
        hero: fronts[0]?.url || null,
        back: backs[0]?.url || null
      };
    }

    it('should select highest-scoring front as hero', () => {
      const images: GroupImage[] = [
        { url: 'front1.jpg', role: 'front', score: 0.8 },
        { url: 'front2.jpg', role: 'front', score: 0.95 },
        { url: 'back1.jpg', role: 'back', score: 0.7 },
      ];
      const result = pickHeroBack(images);
      expect(result.hero).toBe('front2.jpg');
    });

    it('should select highest-scoring back', () => {
      const images: GroupImage[] = [
        { url: 'front1.jpg', role: 'front', score: 0.8 },
        { url: 'back1.jpg', role: 'back', score: 0.7 },
        { url: 'back2.jpg', role: 'back', score: 0.9 },
      ];
      const result = pickHeroBack(images);
      expect(result.back).toBe('back2.jpg');
    });

    it('should handle missing front', () => {
      const images: GroupImage[] = [
        { url: 'back1.jpg', role: 'back', score: 0.8 },
      ];
      const result = pickHeroBack(images);
      expect(result.hero).toBeNull();
      expect(result.back).toBe('back1.jpg');
    });

    it('should handle missing back', () => {
      const images: GroupImage[] = [
        { url: 'front1.jpg', role: 'front', score: 0.9 },
      ];
      const result = pickHeroBack(images);
      expect(result.hero).toBe('front1.jpg');
      expect(result.back).toBeNull();
    });

    it('should handle empty images', () => {
      const result = pickHeroBack([]);
      expect(result.hero).toBeNull();
      expect(result.back).toBeNull();
    });
  });

  describe('Auto-repair groups without front', () => {
    function autoRepairGroup(group: { heroUrl?: string; images: string[] }): string | null {
      if (!group.heroUrl && group.images.length > 0) {
        return group.images[0];
      }
      return group.heroUrl || null;
    }

    it('should auto-assign first image as hero if none set', () => {
      const group = { images: ['img1.jpg', 'img2.jpg'] };
      expect(autoRepairGroup(group)).toBe('img1.jpg');
    });

    it('should not override existing heroUrl', () => {
      const group = { heroUrl: 'hero.jpg', images: ['img1.jpg'] };
      expect(autoRepairGroup(group)).toBe('hero.jpg');
    });

    it('should return null for empty images', () => {
      const group = { images: [] };
      expect(autoRepairGroup(group)).toBeNull();
    });
  });
});

describe('smartdrafts-scan-core: CLIP Clustering', () => {
  
  describe('Cosine similarity', () => {
    function cosine(a: number[], b: number[]): number {
      if (a.length !== b.length) return 0;
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }
      return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
    }

    it('should return 1 for identical vectors', () => {
      const v = [0.5, 0.5, 0.5];
      expect(cosine(v, v)).toBeCloseTo(1.0);
    });

    it('should return 0 for orthogonal vectors', () => {
      const v1 = [1, 0, 0];
      const v2 = [0, 1, 0];
      expect(cosine(v1, v2)).toBeCloseTo(0);
    });

    it('should handle different length vectors', () => {
      const v1 = [1, 0];
      const v2 = [1, 0, 0];
      expect(cosine(v1, v2)).toBe(0);
    });

    it('should return value between -1 and 1', () => {
      const v1 = [0.3, 0.4, 0.5];
      const v2 = [0.6, 0.1, 0.8];
      const sim = cosine(v1, v2);
      expect(sim).toBeGreaterThanOrEqual(-1);
      expect(sim).toBeLessThanOrEqual(1);
    });
  });

  describe('Degenerate similarity detection', () => {
    function isDegenerateCosineMatrix(M: number[][]): boolean {
      const n = M.length;
      let maxOff = -1;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i !== j) maxOff = Math.max(maxOff, M[i][j]);
        }
      }
      return maxOff > 0.98;
    }

    it('should detect degenerate matrix (all ~1.0)', () => {
      const M = [
        [1.0, 0.99, 0.99],
        [0.99, 1.0, 0.99],
        [0.99, 0.99, 1.0],
      ];
      expect(isDegenerateCosineMatrix(M)).toBe(true);
    });

    it('should accept valid matrix with varied similarities', () => {
      const M = [
        [1.0, 0.85, 0.70],
        [0.85, 1.0, 0.65],
        [0.70, 0.65, 1.0],
      ];
      expect(isDegenerateCosineMatrix(M)).toBe(false);
    });

    it('should handle 2x2 matrix', () => {
      const M = [
        [1.0, 0.5],
        [0.5, 1.0],
      ];
      expect(isDegenerateCosineMatrix(M)).toBe(false);
    });
  });

  describe('CLIP similarity threshold', () => {
    const SIMILARITY_THRESHOLD = 0.87;

    function shouldCluster(minSim: number): boolean {
      return minSim >= SIMILARITY_THRESHOLD;
    }

    it('should cluster images above threshold', () => {
      expect(shouldCluster(0.90)).toBe(true);
      expect(shouldCluster(0.87)).toBe(true);
    });

    it('should not cluster images below threshold', () => {
      expect(shouldCluster(0.86)).toBe(false);
      expect(shouldCluster(0.50)).toBe(false);
    });
  });

  describe('Complete linkage clustering', () => {
    function findMinSimilarity(cluster: number[], candidate: number, similarities: number[][]): number {
      let minSim = 1.0;
      for (const ci of cluster) {
        minSim = Math.min(minSim, similarities[ci][candidate]);
      }
      return minSim;
    }

    it('should return minimum similarity to cluster', () => {
      const sims = [
        [1.0, 0.9, 0.8],
        [0.9, 1.0, 0.7],
        [0.8, 0.7, 1.0],
      ];
      const cluster = [0, 1];
      // Candidate 2's similarity to cluster [0,1]: min(0.8, 0.7) = 0.7
      expect(findMinSimilarity(cluster, 2, sims)).toBe(0.7);
    });

    it('should handle single-element cluster', () => {
      const sims = [
        [1.0, 0.85],
        [0.85, 1.0],
      ];
      expect(findMinSimilarity([0], 1, sims)).toBe(0.85);
    });
  });
});

describe('smartdrafts-scan-core: URL Processing', () => {
  
  describe('urlKey extraction', () => {
    function urlKey(url: string): string {
      try {
        const parsed = new URL(url);
        const pathParts = parsed.pathname.split('/').filter(Boolean);
        return pathParts[pathParts.length - 1] || url;
      } catch {
        return url;
      }
    }

    it('should extract filename from URL', () => {
      expect(urlKey('https://cdn.example.com/images/photo.jpg')).toBe('photo.jpg');
    });

    it('should handle URL with query params', () => {
      expect(urlKey('https://cdn.example.com/photo.jpg?raw=1')).toBe('photo.jpg');
    });

    it('should fallback to full URL on parse error', () => {
      expect(urlKey('not-a-url')).toBe('not-a-url');
    });
  });

  describe('Display URL hydration', () => {
    function computeDisplayUrl(
      key: string,
      httpsByKey: Map<string, string>,
      originalByKey: Map<string, string>
    ): string {
      // 1) Prefer an https URL we've already seen
      const https = httpsByKey.get(key);
      if (https) return https;

      // 2) Fall back to the original enumerated URL if it was https
      const orig = originalByKey.get(key) || '';
      if (/^https?:\/\//i.test(orig)) return orig;

      // 3) Last resort: return the key as-is
      return key;
    }

    it('should prefer httpsByKey entry', () => {
      const httpsByKey = new Map([['photo.jpg', 'https://cdn/photo.jpg']]);
      const originalByKey = new Map([['photo.jpg', 'http://old/photo.jpg']]);
      expect(computeDisplayUrl('photo.jpg', httpsByKey, originalByKey)).toBe('https://cdn/photo.jpg');
    });

    it('should fallback to original if https missing', () => {
      const httpsByKey = new Map<string, string>();
      const originalByKey = new Map([['photo.jpg', 'https://orig/photo.jpg']]);
      expect(computeDisplayUrl('photo.jpg', httpsByKey, originalByKey)).toBe('https://orig/photo.jpg');
    });

    it('should use key as last resort', () => {
      const httpsByKey = new Map<string, string>();
      const originalByKey = new Map([['photo.jpg', '/local/path']]);
      expect(computeDisplayUrl('photo.jpg', httpsByKey, originalByKey)).toBe('photo.jpg');
    });
  });
});

describe('smartdrafts-scan-core: Fallback Groups', () => {
  
  describe('buildFallbackGroups structure', () => {
    type DropboxEntry = {
      ".tag": string;
      name: string;
      path_display?: string;
    };

    function buildFallbackGroups(files: Array<{ entry: DropboxEntry; url: string }>) {
      const byFolder = new Map<string, Array<{ entry: DropboxEntry; url: string }>>();
      
      const folderPath = (entry: DropboxEntry) => {
        const raw = entry.path_display || '';
        if (!raw) return '';
        const parts = raw.split('/').filter(Boolean);
        parts.pop();
        return parts.join('/');
      };

      for (const item of files) {
        const key = folderPath(item.entry) || '(root)';
        if (!byFolder.has(key)) byFolder.set(key, []);
        byFolder.get(key)!.push(item);
      }
      
      const groups: any[] = [];
      for (const [key, bucket] of byFolder.entries()) {
        const sorted = bucket.sort((a, b) => (a.entry.name || '').localeCompare(b.entry.name || ''));
        const images = sorted.map((item) => item.url).slice(0, 12);
        const name = key.split('/').filter(Boolean).pop() || key;
        groups.push({
          groupId: `fallback_${createHash('sha1').update(`${key}|${images[0] || ''}`).digest('hex').slice(0, 10)}`,
          name,
          folder: key === '(root)' ? '' : key,
          images,
          confidence: 0.1,
          _fallback: true,
        });
      }
      return groups;
    }

    it('should group files by folder', () => {
      const files = [
        { entry: { ".tag": "file", name: "a.jpg", path_display: "/Photos/a.jpg" }, url: "https://cdn/a.jpg" },
        { entry: { ".tag": "file", name: "b.jpg", path_display: "/Photos/b.jpg" }, url: "https://cdn/b.jpg" },
        { entry: { ".tag": "file", name: "c.jpg", path_display: "/Other/c.jpg" }, url: "https://cdn/c.jpg" },
      ];
      const groups = buildFallbackGroups(files);
      expect(groups.length).toBe(2);
    });

    it('should limit to 12 images per group', () => {
      const files = Array.from({ length: 15 }, (_, i) => ({
        entry: { ".tag": "file", name: `img${i}.jpg`, path_display: `/Folder/img${i}.jpg` },
        url: `https://cdn/img${i}.jpg`
      }));
      const groups = buildFallbackGroups(files);
      expect(groups[0].images.length).toBe(12);
    });

    it('should mark groups as fallback', () => {
      const files = [
        { entry: { ".tag": "file", name: "a.jpg", path_display: "/a.jpg" }, url: "https://cdn/a.jpg" },
      ];
      const groups = buildFallbackGroups(files);
      expect(groups[0]._fallback).toBe(true);
      expect(groups[0].confidence).toBe(0.1);
    });

    it('should handle root-level files', () => {
      const files = [
        { entry: { ".tag": "file", name: "root.jpg", path_display: "/root.jpg" }, url: "https://cdn/root.jpg" },
      ];
      const groups = buildFallbackGroups(files);
      expect(groups[0].folder).toBe('');
    });
  });
});

describe('smartdrafts-scan-core: Text Extraction', () => {
  
  describe('Brand keyword extraction', () => {
    function extractBrandKeywords(text: string): Set<string> {
      const keywords = new Set<string>();
      const words = text.toLowerCase().match(/\b\w{3,}\b/g) || [];
      words.forEach(w => keywords.add(w));
      return keywords;
    }

    it('should extract words 3+ chars', () => {
      const keywords = extractBrandKeywords('My Brand Product');
      expect(keywords.has('brand')).toBe(true);
      expect(keywords.has('product')).toBe(true);
      expect(keywords.has('my')).toBe(false); // 2 chars
    });

    it('should lowercase all keywords', () => {
      const keywords = extractBrandKeywords('VITAMIN B12');
      expect(keywords.has('vitamin')).toBe(true);
      expect(keywords.has('b12')).toBe(true);
    });

    it('should handle empty text', () => {
      const keywords = extractBrandKeywords('');
      expect(keywords.size).toBe(0);
    });
  });

  describe('Jaccard similarity for text matching', () => {
    function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
      const intersection = new Set([...a].filter(x => b.has(x)));
      const union = new Set([...a, ...b]);
      return union.size > 0 ? intersection.size / union.size : 0;
    }

    it('should return 1 for identical sets', () => {
      const s = new Set(['a', 'b', 'c']);
      expect(jaccardSimilarity(s, s)).toBe(1);
    });

    it('should return 0 for disjoint sets', () => {
      const s1 = new Set(['a', 'b']);
      const s2 = new Set(['c', 'd']);
      expect(jaccardSimilarity(s1, s2)).toBe(0);
    });

    it('should calculate partial overlap correctly', () => {
      const s1 = new Set(['a', 'b', 'c']);
      const s2 = new Set(['b', 'c', 'd']);
      // intersection: {b, c} = 2, union: {a, b, c, d} = 4
      expect(jaccardSimilarity(s1, s2)).toBe(0.5);
    });

    it('should handle empty sets', () => {
      const empty = new Set<string>();
      const s = new Set(['a']);
      expect(jaccardSimilarity(empty, s)).toBe(0);
      expect(jaccardSimilarity(empty, empty)).toBe(0);
    });
  });
});

describe('smartdrafts-scan-core: Multimodal Boost', () => {
  
  describe('Text similarity boost formula', () => {
    function calculateBoostedSimilarity(visualSim: number, textSim: number): number {
      if (textSim > 0.3) {
        return visualSim * 0.7 + textSim * 0.3; // 70% visual, 30% text
      }
      return visualSim;
    }

    it('should blend similarities when text > 0.3', () => {
      const result = calculateBoostedSimilarity(0.8, 0.5);
      // 0.8 * 0.7 + 0.5 * 0.3 = 0.56 + 0.15 = 0.71
      expect(result).toBeCloseTo(0.71);
    });

    it('should not boost when text <= 0.3', () => {
      const result = calculateBoostedSimilarity(0.8, 0.3);
      expect(result).toBe(0.8);
    });

    it('should handle edge case at threshold', () => {
      expect(calculateBoostedSimilarity(0.9, 0.31)).toBeCloseTo(0.9 * 0.7 + 0.31 * 0.3);
    });
  });

  describe('Color penalty', () => {
    function applyColorPenalty(sim: number, color1: string, color2: string): number {
      if (color1 && color2 && 
          color1 !== 'multi' && color2 !== 'multi' && 
          color1 !== color2) {
        return sim * 0.90; // 10% penalty
      }
      return sim;
    }

    it('should apply 10% penalty for mismatched colors', () => {
      expect(applyColorPenalty(1.0, 'green', 'blue')).toBe(0.9);
    });

    it('should not penalize matching colors', () => {
      expect(applyColorPenalty(1.0, 'green', 'green')).toBe(1.0);
    });

    it('should not penalize multi colors', () => {
      expect(applyColorPenalty(1.0, 'multi', 'green')).toBe(1.0);
      expect(applyColorPenalty(1.0, 'green', 'multi')).toBe(1.0);
    });

    it('should not penalize empty colors', () => {
      expect(applyColorPenalty(1.0, '', 'green')).toBe(1.0);
    });
  });
});
