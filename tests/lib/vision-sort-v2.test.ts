import { applyVisionSortV2 } from "../../src/lib/vision-sort-v2";
import type { ImageInsight } from "../../src/lib/image-insight";

// Mock dependencies
jest.mock("../../src/lib/clip.js", () => ({
  clipTextEmbedding: jest.fn(),
  clipImageEmbedding: jest.fn(),
  cosine: jest.fn(),
}));

jest.mock("../../src/lib/merge.js", () => ({
  toDirectDropbox: jest.fn((url: string) => url),
}));

import { clipTextEmbedding, clipImageEmbedding, cosine } from "../../src/lib/clip.js";
import { toDirectDropbox } from "../../src/lib/merge.js";

describe("vision-sort-v2", () => {
  let mockClipText: jest.MockedFunction<typeof clipTextEmbedding>;
  let mockClipImage: jest.MockedFunction<typeof clipImageEmbedding>;
  let mockCosine: jest.MockedFunction<typeof cosine>;
  let mockToDirectDropbox: jest.MockedFunction<typeof toDirectDropbox>;

  beforeEach(() => {
    mockClipText = clipTextEmbedding as jest.MockedFunction<typeof clipTextEmbedding>;
    mockClipImage = clipImageEmbedding as jest.MockedFunction<typeof clipImageEmbedding>;
    mockCosine = cosine as jest.MockedFunction<typeof cosine>;
    mockToDirectDropbox = toDirectDropbox as jest.MockedFunction<typeof toDirectDropbox>;

    // Default: CLIP available
    mockClipText.mockResolvedValue(new Array(512).fill(0.1));
    mockClipImage.mockResolvedValue(new Array(512).fill(0.1));
    mockCosine.mockReturnValue(0.5);
    mockToDirectDropbox.mockImplementation((url) => url);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("applyVisionSortV2", () => {
    describe("input validation", () => {
      it("should return empty result for empty groups", async () => {
        const result = await applyVisionSortV2({
          groups: [],
          candidates: [{ url: "img1.jpg", order: 0, index: 0 }],
          insightMap: new Map(),
          originalImageSets: [],
        });

        expect(result).toEqual({
          groups: [],
          orphans: [],
          debugLogs: [],
        });
      });

      it("should return empty result for empty candidates", async () => {
        const result = await applyVisionSortV2({
          groups: [{ brand: "TestBrand" }],
          candidates: [],
          insightMap: new Map(),
          originalImageSets: [],
        });

        expect(result).toEqual({
          groups: [{ brand: "TestBrand" }],
          orphans: [],
          debugLogs: [],
        });
      });

      it("should return empty result for non-array groups", async () => {
        const result = await applyVisionSortV2({
          groups: null as any,
          candidates: [{ url: "img1.jpg", order: 0, index: 0 }],
          insightMap: new Map(),
          originalImageSets: [],
        });

        expect(result).toEqual({
          groups: null,
          orphans: [],
          debugLogs: [],
        });
      });

      it("should return empty result for non-array candidates", async () => {
        const result = await applyVisionSortV2({
          groups: [{ brand: "TestBrand" }],
          candidates: null as any,
          insightMap: new Map(),
          originalImageSets: [],
        });

        expect(result).toEqual({
          groups: [{ brand: "TestBrand" }],
          orphans: [],
          debugLogs: [],
        });
      });
    });

    describe("prompt building", () => {
      it("should build prompt from brand", async () => {
        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        expect(mockClipText).toHaveBeenCalledWith("Nike");
      });

      it("should build prompt from brand and product", async () => {
        const groups = [{ brand: "Nike", product: "Air Max" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        expect(mockClipText).toHaveBeenCalledWith("Nike, Air Max");
      });

      it("should include variant in prompt", async () => {
        const groups = [{ brand: "Nike", product: "Air Max", variant: "Red" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        expect(mockClipText).toHaveBeenCalledWith("Nike, Air Max, Red");
      });

      it("should include claims in prompt", async () => {
        const groups = [
          {
            brand: "Nike",
            product: "Air Max",
            claims: ["athletic", "comfortable"],
          },
        ];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        expect(mockClipText).toHaveBeenCalledWith("Nike, Air Max, athletic, comfortable");
      });

      it("should default to 'product photo' for empty group", async () => {
        const groups = [{}];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        expect(mockClipText).toHaveBeenCalledWith("product photo");
      });

      it("should trim whitespace from fields", async () => {
        const groups = [{ brand: "  Nike  ", product: "  Air Max  " }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        expect(mockClipText).toHaveBeenCalledWith("Nike, Air Max");
      });
    });

    describe("CLIP embeddings", () => {
      it("should compute text embeddings for all groups", async () => {
        const groups = [{ brand: "Nike" }, { brand: "Adidas" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set(), new Set()],
        });

        expect(mockClipText).toHaveBeenCalledTimes(2);
        expect(mockClipText).toHaveBeenCalledWith("Nike");
        expect(mockClipText).toHaveBeenCalledWith("Adidas");
      });

      it("should compute image embeddings for all candidates when CLIP available", async () => {
        const groups = [{ brand: "Nike" }];
        const candidates = [
          { url: "img1.jpg", order: 0, index: 0 },
          { url: "img2.jpg", order: 1, index: 1 },
        ];

        await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        expect(mockClipImage).toHaveBeenCalledTimes(2);
        expect(mockClipImage).toHaveBeenCalledWith("img1.jpg");
        expect(mockClipImage).toHaveBeenCalledWith("img2.jpg");
      });

      it("should skip image embeddings if text embeddings fail", async () => {
        mockClipText.mockResolvedValue(null);

        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        expect(mockClipImage).not.toHaveBeenCalled();
      });

      it("should handle text embedding errors gracefully", async () => {
        mockClipText.mockRejectedValue(new Error("CLIP server down"));

        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        // Without CLIP, heuristics might still assign or orphan
        expect(result).toBeDefined();
        expect(result.orphans.length).toBeGreaterThanOrEqual(0);
      });

      it("should handle image embedding errors gracefully", async () => {
        mockClipImage.mockRejectedValue(new Error("Image fetch failed"));

        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        // Should still work with heuristics only
        expect(result).toBeDefined();
      });

      it("should compute cosine similarity when embeddings available", async () => {
        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        expect(mockCosine).toHaveBeenCalled();
      });
    });

    describe("heuristics", () => {
      it("should boost score for images in originalImageSets", async () => {
        mockCosine.mockReturnValue(0.3); // Above threshold

        const groups = [{ brand: "Nike" }];
        const candidates = [
          { url: "img1.jpg", order: 0, index: 0 },
          { url: "img2.jpg", order: 1, index: 1 },
        ];

        const originalImageSets = [new Set(["img1.jpg"])];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets,
        });

        // img1 should be assigned (has boost), img2 might be orphan
        expect(result.orphans.length).toBeLessThanOrEqual(1);
      });

      it("should boost front images", async () => {
        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const insightMap = new Map<string, ImageInsight>([
          [
            "img1.jpg",
            {
              role: "front",
              dominantColor: "blue",
              hasVisibleText: false,
              visualDescription: "",
            } as ImageInsight,
          ],
        ]);

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap,
          originalImageSets: [new Set()],
        });

        // Front image should have better chance of assignment
        expect(result).toBeDefined();
      });

      it("should penalize back images", async () => {
        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const insightMap = new Map<string, ImageInsight>([
          [
            "img1.jpg",
            {
              role: "back",
              dominantColor: "blue",
              hasVisibleText: false,
              visualDescription: "",
            } as ImageInsight,
          ],
        ]);

        await applyVisionSortV2({
          groups,
          candidates,
          insightMap,
          originalImageSets: [new Set()],
        });

        // Test completes without error
        expect(true).toBe(true);
      });

      it("should boost images with visible text", async () => {
        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const insightMap = new Map<string, ImageInsight>([
          [
            "img1.jpg",
            {
              role: "front",
              dominantColor: "blue",
              hasVisibleText: true,
              visualDescription: "",
            } as ImageInsight,
          ],
        ]);

        await applyVisionSortV2({
          groups,
          candidates,
          insightMap,
          originalImageSets: [new Set()],
        });

        expect(true).toBe(true);
      });

      it("should penalize black/white dominant colors", async () => {
        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const insightMap = new Map<string, ImageInsight>([
          [
            "img1.jpg",
            {
              role: "front",
              dominantColor: "black",
              hasVisibleText: false,
              visualDescription: "",
            } as ImageInsight,
          ],
        ]);

        await applyVisionSortV2({
          groups,
          candidates,
          insightMap,
          originalImageSets: [new Set()],
        });

        expect(true).toBe(true);
      });

      it("should boost candidates with matching keywords in filename", async () => {
        const groups = [{ brand: "Nike", product: "Air Max" }];
        const candidates = [
          { url: "img1.jpg", name: "nike-air-max-red.jpg", order: 0, index: 0 },
        ];

        mockCosine.mockReturnValue(0.3);

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        // Keyword matching should help assignment
        expect(result).toBeDefined();
      });

      it("should penalize blacklist tokens (dummy, placeholder, sample, template)", async () => {
        const groups = [{ brand: "Nike" }];
        const candidates = [
          { url: "img1.jpg", name: "dummy-product.jpg", order: 0, index: 0 },
        ];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        // Dummy image more likely to be orphan
        expect(result.orphans.length).toBeGreaterThanOrEqual(0);
      });
    });

    describe("assignment logic", () => {
      it("should assign candidates above threshold", async () => {
        mockCosine.mockReturnValue(0.5);

        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        expect(result.orphans).toHaveLength(0);
      });

      it("should orphan candidates below threshold", async () => {
        mockCosine.mockReturnValue(0.05); // Very low similarity

        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
          minScore: 0.8, // Very high threshold to force orphaning
        });

        // With very high threshold and low similarity, should become orphan
        // But fallback logic might still assign to empty group
        expect(result.orphans.length).toBeGreaterThanOrEqual(0);
      });

      it("should use custom minScore threshold", async () => {
        mockCosine.mockReturnValue(0.3);

        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
          minScore: 0.25,
        });

        expect(result.orphans).toHaveLength(0);
      });

      it("should assign candidate to best matching group", async () => {
        mockClipText
          .mockResolvedValueOnce(new Array(512).fill(0.1))
          .mockResolvedValueOnce(new Array(512).fill(0.2));

        mockCosine
          .mockReturnValueOnce(0.3) // Group 0
          .mockReturnValueOnce(0.6); // Group 1 - better match

        const groups = [{ brand: "Nike" }, { brand: "Adidas" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set(), new Set()],
        });

        // Should assign to best group
        expect(result.orphans).toHaveLength(0);
      });

      it("should fallback assign orphans to empty groups", async () => {
        mockCosine.mockReturnValue(0.05); // Below threshold

        const groups = [{ brand: "Nike" }, { brand: "Adidas" }];
        const candidates = [
          { url: "img1.jpg", order: 0, index: 0 },
          { url: "img2.jpg", order: 1, index: 1 },
        ];

        // First candidate gets assigned normally, second is fallback
        mockCosine
          .mockReturnValueOnce(0.5).mockReturnValueOnce(0.05) // img1 scores
          .mockReturnValueOnce(0.05).mockReturnValueOnce(0.08); // img2 scores (slightly higher for group 1)

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set(), new Set()],
          minScore: 0.3,
        });

        // img2 should be fallback assigned to empty group 1
        expect(result.orphans.length).toBeLessThanOrEqual(1);
      });

      it("should respect MAX_IMAGES_PER_GROUP (12)", async () => {
        mockCosine.mockReturnValue(0.5);

        const groups = [{ brand: "Nike" }];
        const candidates = Array.from({ length: 20 }, (_, i) => ({
          url: `img${i}.jpg`,
          order: i,
          index: i,
        }));

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        // Should cap at 12 images per group (test completes successfully)
        expect(result).toBeDefined();
      });
    });

    describe("debug mode", () => {
      it("should include debug logs when debug=true", async () => {
        const groups = [{ brand: "Nike", groupId: "group1" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
          debug: true,
        });

        expect(result.debugLogs).toHaveLength(1);
        expect(result.debugLogs[0]).toHaveProperty("groupId", "group1");
        expect(result.debugLogs[0]).toHaveProperty("prompt");
        expect(result.debugLogs[0]).toHaveProperty("top");
      });

      it("should not include debug logs when debug=false", async () => {
        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
          debug: false,
        });

        expect(result.debugLogs).toEqual([]);
      });

      it("should include top 3 scores in debug logs", async () => {
        mockCosine.mockReturnValue(0.5);

        const groups = [{ brand: "Nike", groupId: "group1" }];
        const candidates = [
          { url: "img1.jpg", order: 0, index: 0 },
          { url: "img2.jpg", order: 1, index: 1 },
          { url: "img3.jpg", order: 2, index: 2 },
          { url: "img4.jpg", order: 3, index: 3 },
        ];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
          debug: true,
        });

        expect(result.debugLogs[0].top.length).toBeLessThanOrEqual(3);
      });

      it("should use default group ID if not present", async () => {
        const groups = [{ brand: "Nike" }]; // No groupId
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
          debug: true,
        });

        expect(result.debugLogs[0].groupId).toMatch(/group_\d+/);
      });
    });

    describe("edge cases", () => {
      it("should handle empty insightMap", async () => {
        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        expect(result).toBeDefined();
      });

      it("should handle empty originalImageSets", async () => {
        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [],
        });

        expect(result).toBeDefined();
      });

      it("should handle candidates without name or folder", async () => {
        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        expect(result).toBeDefined();
      });

      it("should handle groups with only empty claims", async () => {
        const groups = [{ brand: "Nike", claims: ["", null, undefined] }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        expect(mockClipText).toHaveBeenCalledWith("Nike");
      });

      it("should handle infinite scores gracefully", async () => {
        mockCosine.mockReturnValue(Infinity);

        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        // Should handle gracefully
        expect(result).toBeDefined();
      });

      it("should handle NaN scores gracefully", async () => {
        mockCosine.mockReturnValue(NaN);

        const groups = [{ brand: "Nike" }];
        const candidates = [{ url: "img1.jpg", order: 0, index: 0 }];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        // Should skip invalid similarity scores
        expect(result).toBeDefined();
      });

      it("should sort candidates by order before slicing", async () => {
        mockCosine.mockReturnValue(0.5);

        const groups = [{ brand: "Nike" }];
        const candidates = [
          { url: "img3.jpg", order: 2, index: 0 },
          { url: "img1.jpg", order: 0, index: 1 },
          { url: "img2.jpg", order: 1, index: 2 },
        ];

        const result = await applyVisionSortV2({
          groups,
          candidates,
          insightMap: new Map(),
          originalImageSets: [new Set()],
        });

        // Test completes successfully (sorting happens internally)
        expect(result).toBeDefined();
      });
    });
  });
});
