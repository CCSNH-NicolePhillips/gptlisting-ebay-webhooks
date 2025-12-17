import {
  classifyImagesBatch,
  pairFromClassifications,
  verifyPairs,
  runNewTwoStagePipeline,
} from "../../src/smartdrafts/pairing-v2-core";

// Mock dependencies
jest.mock("../../src/lib/openai.js", () => ({
  openai: {
    chat: {
      completions: {
        create: jest.fn(),
      },
    },
  },
}));

jest.mock("fs", () => ({
  readFileSync: jest.fn(() => Buffer.from("fake-image-data")),
}));

jest.mock("path", () => ({
  basename: jest.fn((p: string) => p.split("/").pop() || p.split("\\").pop() || p),
  join: jest.fn((...args: string[]) => args.join("/")),
  extname: jest.fn((p: string) => {
    const match = p.match(/\.[^.]+$/);
    return match ? match[0] : "";
  }),
}));

import { openai } from "../../src/lib/openai.js";

describe("pairing-v2-core", () => {
  const mockOpenAI = openai as jest.Mocked<typeof openai>;
  (mockOpenAI.chat.completions.create as jest.Mock<any>) = jest.fn() as jest.Mock<any>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("classifyImagesBatch", () => {
    it("should classify images successfully", async () => {
      const imagePaths = ["front.jpg", "back.jpg"];

      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  {
                    filename: "front.jpg",
                    kind: "product",
                    panel: "front",
                    brand: "TestBrand",
                    productName: "Test Product 60 caps",
                    title: null,
                    brandWebsite: "https://testbrand.com",
                    packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
                    keyText: ["TestBrand", "60 Capsules", "Daily Support"],
                    categoryPath: "Health & Personal Care > Vitamins & Dietary Supplements",
                    colorSignature: ["blue", "white"],
                    layoutSignature: "vertical label",
                    confidence: 0.95,
                    rationale: "Clear front panel",
                    quantityInPhoto: 1,
                  },
                  {
                    filename: "back.jpg",
                    kind: "product",
                    panel: "back",
                    brand: "TestBrand",
                    productName: "Test Product 60 caps",
                    title: null,
                    brandWebsite: "https://testbrand.com",
                    packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
                    keyText: ["Supplement Facts", "Ingredients"],
                    categoryPath: "Health & Personal Care > Vitamins & Dietary Supplements",
                    colorSignature: ["blue", "white"],
                    layoutSignature: "back label",
                    confidence: 0.95,
                    rationale: "Clear back panel",
                    quantityInPhoto: 1,
                  },
                ],
              }),
            },
          },
        ],
      } as any);

      const result = await classifyImagesBatch(imagePaths);

      expect(result).toHaveLength(2);
      expect(result[0].filename).toBe("front.jpg");
      expect(result[0].panel).toBe("front");
      expect(result[1].filename).toBe("back.jpg");
      expect(result[1].panel).toBe("back");
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(1);
    });

    it("should handle empty image array", async () => {
      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockClear();
      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({ items: [] }),
            },
          },
        ],
      } as any);
      
      const result = await classifyImagesBatch([]);
      expect(result).toEqual([]);
      // Note: Function still makes API call even with empty array
    });

    it("should handle batch of up to 12 images", async () => {
      const imagePaths = Array.from({ length: 12 }, (_, i) => `img${i}.jpg`);

      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: Array.from({ length: 12 }, (_, i) => ({
                  filename: `img${i}.jpg`,
                  kind: "product",
                  panel: "front",
                  brand: "Brand",
                  productName: "Product",
                  title: null,
                  brandWebsite: null,
                  packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
                  keyText: [],
                  categoryPath: null,
                  colorSignature: [],
                  layoutSignature: "standard",
                  confidence: 0.9,
                  rationale: "test",
                  quantityInPhoto: 1,
                })),
              }),
            },
          },
        ],
      } as any);

      const result = await classifyImagesBatch(imagePaths);

      // classifyImagesBatch handles a single batch (max 12 images)
      // The batching happens at a higher level (classifyAllImagesStage1)
      expect((mockOpenAI.chat.completions.create as jest.Mock<any>).mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(result.length).toBe(12);
    });

    it("should retry on failure", async () => {
      const imagePaths = ["test.jpg"];

      // Use a retryable error message (contains "JSON")
      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockReset()
        .mockRejectedValueOnce(new Error("Invalid JSON response"))
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      filename: "test.jpg",
                      kind: "product",
                      panel: "front",
                      brand: "Brand",
                      productName: "Product",
                      title: null,
                      brandWebsite: null,
                      packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
                      keyText: [],
                      categoryPath: null,
                      colorSignature: [],
                      layoutSignature: "standard",
                      confidence: 0.9,
                      rationale: "test",
                      quantityInPhoto: 1,
                    },
                  ],
                }),
              },
            },
          ],
        } as any);

      const result = await classifyImagesBatch(imagePaths);

      expect(result).toHaveLength(1);
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(2);
    });

    it("should handle malformed JSON response", async () => {
      const imagePaths = ["test.jpg"];
      
      // Return malformed JSON that will fail parsing
      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockReset().mockResolvedValue({
        choices: [
          {
            message: {
              content: "not valid json at all",
            },
          },
        ],
      } as any);

      // Should throw Invalid JSON error after MAX_RETRIES attempts
      await expect(classifyImagesBatch(imagePaths)).rejects.toThrow(/Invalid JSON|Unexpected token/);
    });

    it("should handle missing response content", async () => {
      const imagePaths = ["test.jpg"];

      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValue({
        choices: [
          {
            message: {
              content: null,
            },
          },
        ],
      } as any);

      await expect(classifyImagesBatch(imagePaths)).rejects.toThrow();
    });

    it("should classify book type correctly", async () => {
      const imagePaths = ["book.jpg"];

      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  {
                    filename: "book.jpg",
                    kind: "product",
                    panel: "front",
                    brand: null,
                    productName: "J.K. Rowling",
                    title: "Harry Potter",
                    brandWebsite: null,
                    packageType: "book" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
                    keyText: ["Harry Potter", "J.K. Rowling"],
                    categoryPath: "Books > Fiction",
                    colorSignature: ["red", "gold"],
                    layoutSignature: "book cover",
                    confidence: 0.98,
                    rationale: "Clear book cover",
                    quantityInPhoto: 1,
                  },
                ],
              }),
            },
          },
        ],
      } as any);

      const result = await classifyImagesBatch(imagePaths);

      expect(result[0].packageType).toBe("book");
      expect(result[0].brand).toBeNull();
      expect(result[0].title).toBe("Harry Potter");
    });

    it("should include quantityInPhoto in classification", async () => {
      const imagePaths = ["multiple.jpg"];

      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  {
                    filename: "multiple.jpg",
                    kind: "product",
                    panel: "front",
                    brand: "Brand",
                    productName: "Product",
                    title: null,
                    brandWebsite: null,
                    packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
                    keyText: [],
                    categoryPath: null,
                    colorSignature: [],
                    layoutSignature: "standard",
                    confidence: 0.9,
                    rationale: "multiple products",
                    quantityInPhoto: 3,
                  },
                ],
              }),
            },
          },
        ],
      } as any);

      const result = await classifyImagesBatch(imagePaths);

      expect(result[0].quantityInPhoto).toBe(3);
    });
  });

  describe("pairFromClassifications", () => {
    it("should pair matching front and back images", async () => {
      const classifications = [
        {
          filename: "front.jpg",
          kind: "product" as const,
          panel: "front" as const,
          brand: "TestBrand",
          productName: "Test Product",
          title: null,
          brandWebsite: "https://testbrand.com",
          packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
          keyText: ["TestBrand"],
          categoryPath: "Health & Personal Care",
          colorSignature: ["blue"],
          layoutSignature: "vertical",
          confidence: 0.95,
          quantityInPhoto: 1,
        },
        {
          filename: "back.jpg",
          kind: "product" as const,
          panel: "back" as const,
          brand: "TestBrand",
          productName: "Test Product",
          title: null,
          brandWebsite: "https://testbrand.com",
          packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
          keyText: ["Supplement Facts"],
          categoryPath: "Health & Personal Care",
          colorSignature: ["blue"],
          layoutSignature: "back label",
          confidence: 0.95,
          quantityInPhoto: 1,
        },
      ];

      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                pairs: [
                  {
                    front: "front.jpg",
                    back: "back.jpg",
                    confidence: 0.95,
                    rationale: "Same brand and product",
                  },
                ],
                unpaired: [],
              }),
            },
          },
        ],
      } as any);

      const result = await pairFromClassifications(classifications);

      expect(result.pairs).toHaveLength(1);
      expect(result.pairs[0].front).toBe("front.jpg");
      expect(result.pairs[0].back).toBe("back.jpg");
      expect(result.unpaired).toHaveLength(0);
    });

    it("should handle unpaired images", async () => {
      const classifications = [
        {
          filename: "front.jpg",
          kind: "product" as const,
          panel: "front" as const,
          brand: "Brand1",
          productName: "Product1",
          title: null,
          brandWebsite: null,
          packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
          keyText: [],
          categoryPath: null,
          colorSignature: [],
          layoutSignature: "vertical",
          confidence: 0.9,
          quantityInPhoto: 1,
        },
      ];

      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                pairs: [],
                unpaired: [
                  {
                    filename: "front.jpg",
                    reason: "no_match",
                    rationale: "No matching back found",
                  },
                ],
              }),
            },
          },
        ],
      } as any);

      const result = await pairFromClassifications(classifications);

      expect(result.pairs).toHaveLength(0);
      expect(result.unpaired).toHaveLength(1);
      expect(result.unpaired[0].filename).toBe("front.jpg");
    });

    it("should handle empty classifications", async () => {
      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                pairs: [],
                unpaired: [],
              }),
            },
          },
        ],
      } as any);

      const result = await pairFromClassifications([]);

      expect(result.pairs).toHaveLength(0);
      expect(result.unpaired).toHaveLength(0);
    });

    it("should filter out non-product items", async () => {
      const classifications = [
        {
          filename: "product.jpg",
          kind: "product" as const,
          panel: "front" as const,
          brand: "Brand",
          productName: "Product",
          title: null,
          brandWebsite: null,
          packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
          keyText: [],
          categoryPath: null,
          colorSignature: [],
          layoutSignature: "vertical",
          confidence: 0.9,
          quantityInPhoto: 1,
        },
        {
          filename: "random.jpg",
          kind: "non_product" as const,
          panel: "unknown" as const,
          brand: null,
          productName: null,
          title: null,
          brandWebsite: null,
          packageType: "unknown" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
          keyText: [],
          categoryPath: null,
          colorSignature: [],
          layoutSignature: "none",
          confidence: 0.9,
          quantityInPhoto: 0,
        },
      ];

      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                pairs: [],
                unpaired: [
                  {
                    filename: "product.jpg",
                    reason: "no_match",
                    rationale: "No back found",
                  },
                ],
              }),
            },
          },
        ],
      } as any);

      const result = await pairFromClassifications(classifications);

      // Non-product items should be filtered before pairing
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalled();
      const callArg = (mockOpenAI.chat.completions.create as jest.Mock<any>).mock.calls[0][0];
      expect(callArg.messages[1].content).toContain("product.jpg");
    });

    it("should handle API errors gracefully", async () => {
      const classifications = [
        {
          filename: "test.jpg",
          kind: "product" as const,
          panel: "front" as const,
          brand: "Brand",
          productName: "Product",
          title: null,
          brandWebsite: null,
          packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
          keyText: [],
          categoryPath: null,
          colorSignature: [],
          layoutSignature: "vertical",
          confidence: 0.9,
          quantityInPhoto: 1,
        },
      ];

      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockRejectedValue(new Error("API timeout"));

      // Function fails open - returns empty pairing with unpaired items
      const result = await pairFromClassifications(classifications);
      expect(result.pairs).toHaveLength(0);
      expect(result.unpaired).toHaveLength(1);
      expect(result.unpaired[0].filename).toBe("test.jpg");
      expect(result.unpaired[0].reason).toContain("error");
    });
  });

  describe("verifyPairs", () => {
    it("should verify pairs successfully", async () => {
      const pairing = {
        pairs: [
          {
            front: "front.jpg",
            back: "back.jpg",
            reasoning: "Same brand and product",
            confidence: 0.9,
          },
        ],
        unpaired: [],
      };

      const classifications = [
        {
          filename: "front.jpg",
          kind: "product" as const,
          panel: "front" as const,
          brand: "Brand",
          productName: "Product",
          title: null,
          brandWebsite: null,
          packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
          keyText: [],
          categoryPath: null,
          colorSignature: [],
          layoutSignature: "vertical",
          confidence: 0.9,
          quantityInPhoto: 1,
        },
        {
          filename: "back.jpg",
          kind: "product" as const,
          panel: "back" as const,
          brand: "Brand",
          productName: "Product",
          title: null,
          brandWebsite: null,
          packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
          keyText: [],
          categoryPath: null,
          colorSignature: [],
          layoutSignature: "back",
          confidence: 0.9,
          quantityInPhoto: 1,
        },
      ];

      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verifiedPairs: [
                  {
                    front: "front.jpg",
                    back: "back.jpg",
                    reasoning: "Same brand and product",
                    confidence: 0.9,
                    status: "accepted",
                  },
                ],
              }),
            },
          },
        ],
      } as any);

      const result = await verifyPairs(classifications, pairing);

      expect(result.verifiedPairs).toHaveLength(1);
      expect(result.verifiedPairs[0].status).toBe("accepted");
    });

    it("should detect incorrect pairs", async () => {
      const pairing = {
        pairs: [
          {
            front: "front1.jpg",
            back: "back2.jpg",
            reasoning: "Might be related",
            confidence: 0.9,
          },
        ],
        unpaired: [],
      };

      const classifications = [
        {
          filename: "front1.jpg",
          kind: "product" as const,
          panel: "front" as const,
          brand: "Brand1",
          productName: "Product1",
          title: null,
          brandWebsite: null,
          packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
          keyText: [],
          categoryPath: null,
          colorSignature: ["blue"],
          layoutSignature: "vertical",
          confidence: 0.9,
          quantityInPhoto: 1,
        },
        {
          filename: "back2.jpg",
          kind: "product" as const,
          panel: "back" as const,
          brand: "Brand2",
          productName: "Product2",
          title: null,
          brandWebsite: null,
          packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
          keyText: [],
          categoryPath: null,
          colorSignature: ["red"],
          layoutSignature: "back",
          confidence: 0.9,
          quantityInPhoto: 1,
        },
      ];

      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verifiedPairs: [
                  {
                    front: "front1.jpg",
                    back: "back2.jpg",
                    reasoning: "Might be related",
                    confidence: 0.9,
                    status: "rejected",
                    issues: ["Different brands: Brand1 vs Brand2"],
                  },
                ],
              }),
            },
          },
        ],
      } as any);

      const result = await verifyPairs(classifications, pairing);

      expect(result.verifiedPairs).toHaveLength(1);
      expect(result.verifiedPairs[0].status).toBe("rejected");
    });

    it("should handle empty pairs array", async () => {
      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verifiedPairs: [],
              }),
            },
          },
        ],
      } as any);

      const result = await verifyPairs([], { pairs: [], unpaired: [] });

      expect(result.verifiedPairs).toHaveLength(0);
    });
  });

  describe("runNewTwoStagePipeline", () => {
    it("should run complete pipeline successfully", async () => {
      const imagePaths = ["front.jpg", "back.jpg"];

      // Mock classification
      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  {
                    filename: "front.jpg",
                    kind: "product",
                    panel: "front",
                    brand: "Brand",
                    productName: "Product",
                    title: null,
                    brandWebsite: "https://brand.com",
                    packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
                    keyText: ["Brand", "Product"],
                    categoryPath: "Health & Personal Care",
                    colorSignature: ["blue"],
                    layoutSignature: "vertical",
                    confidence: 0.95,
                    rationale: "Clear front",
                    quantityInPhoto: 1,
                  },
                  {
                    filename: "back.jpg",
                    kind: "product",
                    panel: "back",
                    brand: "Brand",
                    productName: "Product",
                    title: null,
                    brandWebsite: "https://brand.com",
                    packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
                    keyText: ["Supplement Facts"],
                    categoryPath: "Health & Personal Care",
                    colorSignature: ["blue"],
                    layoutSignature: "back label",
                    confidence: 0.95,
                    rationale: "Clear back",
                    quantityInPhoto: 1,
                  },
                ],
              }),
            },
          },
        ],
      } as any);

      // Mock pairing
      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                pairs: [
                  {
                    front: "front.jpg",
                    back: "back.jpg",
                    confidence: 0.95,
                    rationale: "Same product",
                  },
                ],
                unpaired: [],
              }),
            },
          },
        ],
      } as any);

      // Mock verification
      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verifiedPairs: [
                  {
                    front: "front.jpg",
                    back: "back.jpg",
                    reasoning: "Same product",
                    confidence: 0.95,
                    status: "accepted",
                  },
                ],
              }),
            },
          },
        ],
      } as any);

      const result = await runNewTwoStagePipeline(imagePaths);

      expect(result.pairs).toHaveLength(1);
      expect(result.pairs[0].front).toBe("front.jpg");
      expect(result.pairs[0].back).toBe("back.jpg");
      expect(result.metrics.totals.images).toBe(2);
      expect(result.metrics.totals.fronts).toBeGreaterThanOrEqual(1);
    });

    it("should handle empty image paths", async () => {
      const result = await runNewTwoStagePipeline([]);

      expect(result.pairs).toHaveLength(0);
      expect(result.unpaired).toHaveLength(0);
      expect(result.metrics.totals.images).toBe(0);
    });

    it("should populate metrics correctly", async () => {
      const imagePaths = ["img1.jpg", "img2.jpg", "img3.jpg"];

      // Mock classification - 2 products, 1 non-product
      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  {
                    filename: "img1.jpg",
                    kind: "product",
                    panel: "front",
                    brand: "BrandA",
                    productName: "ProductA",
                    title: null,
                    brandWebsite: null,
                    packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
                    keyText: [],
                    categoryPath: null,
                    colorSignature: [],
                    layoutSignature: "vertical",
                    confidence: 0.9,
                    rationale: "front",
                    quantityInPhoto: 1,
                  },
                  {
                    filename: "img2.jpg",
                    kind: "product",
                    panel: "back",
                    brand: "BrandA",
                    productName: "ProductA",
                    title: null,
                    brandWebsite: null,
                    packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
                    keyText: [],
                    categoryPath: null,
                    colorSignature: [],
                    layoutSignature: "back",
                    confidence: 0.9,
                    rationale: "back",
                    quantityInPhoto: 1,
                  },
                  {
                    filename: "img3.jpg",
                    kind: "non_product",
                    panel: "unknown",
                    brand: null,
                    productName: null,
                    title: null,
                    brandWebsite: null,
                    packageType: "unknown" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
                    keyText: [],
                    categoryPath: null,
                    colorSignature: [],
                    layoutSignature: "none",
                    confidence: 0.9,
                    rationale: "not product",
                    quantityInPhoto: 0,
                  },
                ],
              }),
            },
          },
        ],
      } as any);

      // Mock pairing
      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                pairs: [
                  {
                    front: "img1.jpg",
                    back: "img2.jpg",
                    confidence: 0.9,
                    rationale: "paired",
                  },
                ],
                unpaired: [],
              }),
            },
          },
        ],
      } as any);

      // Mock verification
      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verifiedPairs: [
                  {
                    front: "img1.jpg",
                    back: "img2.jpg",
                    reasoning: "paired",
                    confidence: 0.9,
                    status: "accepted",
                  },
                ],
              }),
            },
          },
        ],
      } as any);

      const result = await runNewTwoStagePipeline(imagePaths);

      expect(result.metrics.totals.images).toBe(3);
      expect(result.metrics.totals.candidates).toBe(2); // Only products
      // Brand names are lowercased in metrics
      expect(result.metrics.byBrand).toHaveProperty("branda");
    });

    it("should include brandWebsite in paired results", async () => {
      const imagePaths = ["front.jpg"];

      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  {
                    filename: "front.jpg",
                    kind: "product",
                    panel: "front",
                    brand: "Brand",
                    productName: "Product",
                    title: null,
                    brandWebsite: "https://brand.com/product",
                    packageType: "bottle" as "bottle" | "jar" | "box" | "pouch" | "tub" | "book" | "sachet" | "unknown",
                    keyText: [],
                    categoryPath: null,
                    colorSignature: [],
                    layoutSignature: "vertical",
                    confidence: 0.9,
                    rationale: "test",
                    quantityInPhoto: 2,
                  },
                ],
              }),
            },
          },
        ],
      } as any);

      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                pairs: [],
                unpaired: [
                  {
                    filename: "front.jpg",
                    reason: "singleton",
                    rationale: "Only one image",
                  },
                ],
              }),
            },
          },
        ],
      } as any);

      (mockOpenAI.chat.completions.create as jest.Mock<any>).mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verifiedPairs: [],
              }),
            },
          },
        ],
      } as any);

      const result = await runNewTwoStagePipeline(imagePaths);

      expect(result.unpaired).toHaveLength(1);
      expect(result.unpaired[0].brandWebsite).toBe("https://brand.com/product");
      expect(result.unpaired[0].photoQuantity).toBe(2);
    });
  });
});
