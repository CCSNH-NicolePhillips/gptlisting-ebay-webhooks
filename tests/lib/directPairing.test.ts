import { directPairProductsFromImages, DirectPairImageInput } from "../../src/lib/directPairing";

// Mock dependencies
jest.mock("openai");
jest.mock("node-fetch", () => ({
  __esModule: true,
  default: jest.fn(),
}));

import OpenAI from "openai";
import fetch from "node-fetch";
import { Response } from "node-fetch";

describe("directPairing", () => {
  let openaiMock: any;
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    // Mock OpenAI client
    openaiMock = {
      chat: {
        completions: {
          create: jest.fn(),
        },
      },
    } as any;

    (OpenAI as jest.MockedClass<typeof OpenAI>).mockImplementation(() => openaiMock);

    // Mock fetch
    fetchMock = fetch as jest.MockedFunction<typeof fetch>;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("directPairProductsFromImages", () => {
    describe("input validation", () => {
      it("should return empty products for empty images array", async () => {
        const result = await directPairProductsFromImages([]);
        expect(result).toEqual({ products: [] });
      });

      it("should return empty products if no images could be downloaded", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/img1.jpg", filename: "img1.jpg" },
        ];

        // Mock failed download
        fetchMock.mockResolvedValue({
          ok: false,
          status: 404,
          statusText: "Not Found",
        } as Response);

        const result = await directPairProductsFromImages(images);
        expect(result).toEqual({ products: [] });
      });

      it("should continue processing if some images fail to download", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/img1.jpg", filename: "img1.jpg" },
          { url: "https://example.com/img2.jpg", filename: "img2.jpg" },
        ];

        // First download fails, second succeeds
        fetchMock
          .mockResolvedValueOnce({
            ok: false,
            status: 404,
            statusText: "Not Found",
          } as Response)
          .mockResolvedValueOnce({
            ok: true,
            buffer: async () => Buffer.from("fake-image-data"),
            headers: { get: () => "image/jpeg" },
          } as any);

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  products: [
                    {
                      productName: "Test Product",
                      frontImage: "img2.jpg",
                      backImage: "img2.jpg",
                    },
                  ],
                }),
              },
            },
          ],
        } as any);

        const result = await directPairProductsFromImages(images);
        expect(result.products).toHaveLength(1);
      });

      it("should handle download errors gracefully", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/img1.jpg", filename: "img1.jpg" },
        ];

        fetchMock.mockRejectedValue(new Error("Network error"));

        const result = await directPairProductsFromImages(images);
        expect(result).toEqual({ products: [] });
      });
    });

    describe("image processing", () => {
      it("should download images and convert to base64", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/front.jpg", filename: "front.jpg" },
          { url: "https://example.com/back.jpg", filename: "back.jpg" },
        ];

        fetchMock.mockResolvedValue({
          ok: true,
          buffer: async () => Buffer.from("fake-image-data"),
          headers: { get: () => "image/jpeg" },
        } as any);

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  products: [
                    {
                      productName: "Product 1",
                      frontImage: "front.jpg",
                      backImage: "back.jpg",
                    },
                  ],
                }),
              },
            },
          ],
        } as any);

        await directPairProductsFromImages(images);

        // Verify OpenAI was called with base64 images
        expect(openaiMock.chat.completions.create).toHaveBeenCalledWith(
          expect.objectContaining({
            messages: expect.arrayContaining([
              expect.objectContaining({
                role: "user",
                content: expect.arrayContaining([
                  expect.objectContaining({
                    type: "image_url",
                    image_url: expect.objectContaining({
                      url: expect.stringContaining("data:image/jpeg;base64,"),
                    }),
                  }),
                ]),
              }),
            ]),
          })
        );
      });

      it("should use correct mime type from response headers", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/image.png", filename: "image.png" },
        ];

        fetchMock.mockResolvedValue({
          ok: true,
          buffer: async () => Buffer.from("fake-image-data"),
          headers: { get: () => "image/png" },
        } as any);

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  products: [],
                }),
              },
            },
          ],
        } as any);

        await directPairProductsFromImages(images);

        const call = openaiMock.chat.completions.create.mock.calls[0][0];
        const userMessage = call.messages.find((m: any) => m.role === "user");
        const imageContent = userMessage.content.find((c: any) => c.type === "image_url");
        
        expect(imageContent.image_url.url).toContain("data:image/png;base64,");
      });

      it("should default to image/jpeg if content-type is missing", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/image.jpg", filename: "image.jpg" },
        ];

        fetchMock.mockResolvedValue({
          ok: true,
          buffer: async () => Buffer.from("fake-image-data"),
          headers: { get: () => null },
        } as any);

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  products: [],
                }),
              },
            },
          ],
        } as any);

        await directPairProductsFromImages(images);

        const call = openaiMock.chat.completions.create.mock.calls[0][0];
        const userMessage = call.messages.find((m: any) => m.role === "user");
        const imageContent = userMessage.content.find((c: any) => c.type === "image_url");
        
        expect(imageContent.image_url.url).toContain("data:image/jpeg;base64,");
      });
    });

    describe("GPT-4o API calls", () => {
      beforeEach(() => {
        fetchMock.mockResolvedValue({
          ok: true,
          buffer: async () => Buffer.from("fake-image-data"),
          headers: { get: () => "image/jpeg" },
        } as any);
      });

      it("should use gpt-4o model", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/img.jpg", filename: "img.jpg" },
        ];

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({ products: [] }),
              },
            },
          ],
        } as any);

        await directPairProductsFromImages(images);

        expect(openaiMock.chat.completions.create).toHaveBeenCalledWith(
          expect.objectContaining({
            model: "gpt-4o",
          })
        );
      });

      it("should use temperature 0 for consistent results", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/img.jpg", filename: "img.jpg" },
        ];

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({ products: [] }),
              },
            },
          ],
        } as any);

        await directPairProductsFromImages(images);

        expect(openaiMock.chat.completions.create).toHaveBeenCalledWith(
          expect.objectContaining({
            temperature: 0,
          })
        );
      });

      it("should use json_schema response format", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/img.jpg", filename: "img.jpg" },
        ];

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({ products: [] }),
              },
            },
          ],
        } as any);

        await directPairProductsFromImages(images);

        expect(openaiMock.chat.completions.create).toHaveBeenCalledWith(
          expect.objectContaining({
            response_format: expect.objectContaining({
              type: "json_schema",
              json_schema: expect.objectContaining({
                name: "direct_pairs",
              }),
            }),
          })
        );
      });

      it("should include system message for pairing instructions", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/img.jpg", filename: "img.jpg" },
        ];

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({ products: [] }),
              },
            },
          ],
        } as any);

        await directPairProductsFromImages(images);

        const call = openaiMock.chat.completions.create.mock.calls[0][0];
        const systemMessage = call.messages.find((m: any) => m.role === "system");
        
        expect(systemMessage).toBeDefined();
        expect(systemMessage.content).toContain("front and back images");
      });

      it("should include filenames in user message", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/front.jpg", filename: "front.jpg" },
          { url: "https://example.com/back.jpg", filename: "back.jpg" },
        ];

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({ products: [] }),
              },
            },
          ],
        } as any);

        await directPairProductsFromImages(images);

        const call = openaiMock.chat.completions.create.mock.calls[0][0];
        const userMessage = call.messages.find((m: any) => m.role === "user");
        const textContents = userMessage.content.filter((c: any) => c.type === "text");
        
        const textContent = textContents.map((c: any) => c.text).join(" ");
        expect(textContent).toContain("front.jpg");
        expect(textContent).toContain("back.jpg");
      });

      it("should throw error if GPT-4o returns no content", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/img.jpg", filename: "img.jpg" },
        ];

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: null,
              },
            },
          ],
        } as any);

        await expect(directPairProductsFromImages(images)).rejects.toThrow(
          "No content in GPT-4o response"
        );
      });

      it("should throw error if GPT-4o returns empty choices", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/img.jpg", filename: "img.jpg" },
        ];

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [],
        } as any);

        await expect(directPairProductsFromImages(images)).rejects.toThrow(
          "No content in GPT-4o response"
        );
      });
    });

    describe("product validation", () => {
      beforeEach(() => {
        fetchMock.mockResolvedValue({
          ok: true,
          buffer: async () => Buffer.from("fake-image-data"),
          headers: { get: () => "image/jpeg" },
        } as any);
      });

      it("should return valid products", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/front.jpg", filename: "front.jpg" },
          { url: "https://example.com/back.jpg", filename: "back.jpg" },
        ];

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  products: [
                    {
                      productName: "Product 1",
                      frontImage: "front.jpg",
                      backImage: "back.jpg",
                    },
                  ],
                }),
              },
            },
          ],
        } as any);

        const result = await directPairProductsFromImages(images);

        expect(result.products).toEqual([
          {
            productName: "Product 1",
            frontImage: "front.jpg",
            backImage: "back.jpg",
          },
        ]);
      });

      it("should filter out products with invalid front filenames", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/img1.jpg", filename: "img1.jpg" },
          { url: "https://example.com/img2.jpg", filename: "img2.jpg" },
        ];

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  products: [
                    {
                      productName: "Product 1",
                      frontImage: "invalid.jpg", // Not in downloaded images
                      backImage: "img2.jpg",
                    },
                    {
                      productName: "Product 2",
                      frontImage: "img1.jpg",
                      backImage: "img2.jpg",
                    },
                  ],
                }),
              },
            },
          ],
        } as any);

        const result = await directPairProductsFromImages(images);

        expect(result.products).toEqual([
          {
            productName: "Product 2",
            frontImage: "img1.jpg",
            backImage: "img2.jpg",
          },
        ]);
      });

      it("should filter out products with invalid back filenames", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/img1.jpg", filename: "img1.jpg" },
          { url: "https://example.com/img2.jpg", filename: "img2.jpg" },
        ];

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  products: [
                    {
                      productName: "Product 1",
                      frontImage: "img1.jpg",
                      backImage: "invalid.jpg", // Not in downloaded images
                    },
                    {
                      productName: "Product 2",
                      frontImage: "img1.jpg",
                      backImage: "img2.jpg",
                    },
                  ],
                }),
              },
            },
          ],
        } as any);

        const result = await directPairProductsFromImages(images);

        expect(result.products).toEqual([
          {
            productName: "Product 2",
            frontImage: "img1.jpg",
            backImage: "img2.jpg",
          },
        ]);
      });

      it("should handle multiple valid products", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/img1.jpg", filename: "img1.jpg" },
          { url: "https://example.com/img2.jpg", filename: "img2.jpg" },
          { url: "https://example.com/img3.jpg", filename: "img3.jpg" },
          { url: "https://example.com/img4.jpg", filename: "img4.jpg" },
        ];

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  products: [
                    {
                      productName: "Product 1",
                      frontImage: "img1.jpg",
                      backImage: "img2.jpg",
                    },
                    {
                      productName: "Product 2",
                      frontImage: "img3.jpg",
                      backImage: "img4.jpg",
                    },
                  ],
                }),
              },
            },
          ],
        } as any);

        const result = await directPairProductsFromImages(images);

        expect(result.products).toHaveLength(2);
        expect(result.products).toEqual([
          {
            productName: "Product 1",
            frontImage: "img1.jpg",
            backImage: "img2.jpg",
          },
          {
            productName: "Product 2",
            frontImage: "img3.jpg",
            backImage: "img4.jpg",
          },
        ]);
      });
    });

    describe("edge cases", () => {
      beforeEach(() => {
        fetchMock.mockResolvedValue({
          ok: true,
          buffer: async () => Buffer.from("fake-image-data"),
          headers: { get: () => "image/jpeg" },
        } as any);
      });

      it("should handle empty products array from GPT-4o", async () => {
        const images: DirectPairImageInput[] = [
          { url: "https://example.com/img.jpg", filename: "img.jpg" },
        ];

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({ products: [] }),
              },
            },
          ],
        } as any);

        const result = await directPairProductsFromImages(images);
        expect(result).toEqual({ products: [] });
      });

      it("should handle large image sets", async () => {
        const images: DirectPairImageInput[] = Array.from({ length: 50 }, (_, i) => ({
          url: `https://example.com/img${i}.jpg`,
          filename: `img${i}.jpg`,
        }));

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  products: Array.from({ length: 25 }, (_, i) => ({
                    productName: `Product ${i}`,
                    frontImage: `img${i * 2}.jpg`,
                    backImage: `img${i * 2 + 1}.jpg`,
                  })),
                }),
              },
            },
          ],
        } as any);

        const result = await directPairProductsFromImages(images);
        expect(result.products).toHaveLength(25);
      });

      it("should handle special characters in filenames", async () => {
        const images: DirectPairImageInput[] = [
          {
            url: "https://example.com/image%201.jpg",
            filename: "image 1.jpg",
          },
          {
            url: "https://example.com/image%20%28copy%29.jpg",
            filename: "image (copy).jpg",
          },
        ];

        openaiMock.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  products: [
                    {
                      productName: "Product 1",
                      frontImage: "image 1.jpg",
                      backImage: "image (copy).jpg",
                    },
                  ],
                }),
              },
            },
          ],
        } as any);

        const result = await directPairProductsFromImages(images);
        expect(result.products).toHaveLength(1);
        expect(result.products[0].frontImage).toBe("image 1.jpg");
      });
    });
  });
});
