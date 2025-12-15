// Mock dependencies
jest.mock("../../src/lib/clip-provider.js");
jest.mock("../../src/lib/clip-client-split.js");

import { clipTextEmbedding, clipImageEmbedding, cosine } from "../../src/lib/clip";
import { getTextEmb, getImageEmb } from "../../src/lib/clip-provider.js";
import { cosine as clientCosine } from "../../src/lib/clip-client-split.js";

const mockGetTextEmb = getTextEmb as jest.MockedFunction<typeof getTextEmb>;
const mockGetImageEmb = getImageEmb as jest.MockedFunction<typeof getImageEmb>;
const mockClientCosine = clientCosine as jest.MockedFunction<typeof clientCosine>;

describe("clip module", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("clipTextEmbedding", () => {
    it("should call getTextEmb with text", async () => {
      const mockEmbedding = [0.1, 0.2, 0.3];
      mockGetTextEmb.mockResolvedValueOnce(mockEmbedding);

      const result = await clipTextEmbedding("test text");

      expect(mockGetTextEmb).toHaveBeenCalledWith("test text");
      expect(result).toEqual(mockEmbedding);
    });

    it("should return null when getTextEmb returns null", async () => {
      mockGetTextEmb.mockResolvedValueOnce(null);

      const result = await clipTextEmbedding("empty text");

      expect(result).toBeNull();
    });

    it("should handle special characters in text", async () => {
      const mockEmbedding = [0.5, 0.6];
      mockGetTextEmb.mockResolvedValueOnce(mockEmbedding);

      const result = await clipTextEmbedding("Special™ çhãracters! @#$%");

      expect(mockGetTextEmb).toHaveBeenCalledWith("Special™ çhãracters! @#$%");
      expect(result).toEqual(mockEmbedding);
    });

    it("should handle empty string", async () => {
      mockGetTextEmb.mockResolvedValueOnce([]);

      const result = await clipTextEmbedding("");

      expect(mockGetTextEmb).toHaveBeenCalledWith("");
      expect(result).toEqual([]);
    });

    it("should propagate errors from getTextEmb", async () => {
      mockGetTextEmb.mockRejectedValueOnce(new Error("API error"));

      await expect(clipTextEmbedding("test")).rejects.toThrow("API error");
    });
  });

  describe("clipImageEmbedding", () => {
    it("should call getImageEmb with imageUrl", async () => {
      const mockEmbedding = [0.7, 0.8, 0.9];
      mockGetImageEmb.mockResolvedValueOnce(mockEmbedding);

      const result = await clipImageEmbedding("https://example.com/image.jpg");

      expect(mockGetImageEmb).toHaveBeenCalledWith("https://example.com/image.jpg");
      expect(result).toEqual(mockEmbedding);
    });

    it("should return null when getImageEmb returns null", async () => {
      mockGetImageEmb.mockResolvedValueOnce(null);

      const result = await clipImageEmbedding("https://example.com/missing.jpg");

      expect(result).toBeNull();
    });

    it("should handle data URLs", async () => {
      const mockEmbedding = [0.1, 0.2];
      mockGetImageEmb.mockResolvedValueOnce(mockEmbedding);

      const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANS";
      const result = await clipImageEmbedding(dataUrl);

      expect(mockGetImageEmb).toHaveBeenCalledWith(dataUrl);
      expect(result).toEqual(mockEmbedding);
    });

    it("should handle S3 URLs", async () => {
      const mockEmbedding = [0.3, 0.4];
      mockGetImageEmb.mockResolvedValueOnce(mockEmbedding);

      const s3Url = "https://bucket.s3.amazonaws.com/path/to/image.png";
      const result = await clipImageEmbedding(s3Url);

      expect(mockGetImageEmb).toHaveBeenCalledWith(s3Url);
      expect(result).toEqual(mockEmbedding);
    });

    it("should propagate errors from getImageEmb", async () => {
      mockGetImageEmb.mockRejectedValueOnce(new Error("Network error"));

      await expect(clipImageEmbedding("https://example.com/image.jpg")).rejects.toThrow(
        "Network error"
      );
    });

    it("should handle empty embedding arrays", async () => {
      mockGetImageEmb.mockResolvedValueOnce([]);

      const result = await clipImageEmbedding("https://example.com/blank.jpg");

      expect(result).toEqual([]);
    });
  });

  describe("cosine", () => {
    it("should export cosine from clip-client-split", () => {
      expect(cosine).toBe(clientCosine);
    });

    it("should calculate cosine similarity when called", () => {
      mockClientCosine.mockReturnValueOnce(0.95);

      const vec1 = [1, 0, 0];
      const vec2 = [0.9, 0.1, 0];
      const result = cosine(vec1, vec2);

      expect(mockClientCosine).toHaveBeenCalledWith(vec1, vec2);
      expect(result).toBe(0.95);
    });

    it("should handle zero vectors", () => {
      mockClientCosine.mockReturnValueOnce(0);

      const vec1 = [0, 0, 0];
      const vec2 = [1, 2, 3];
      const result = cosine(vec1, vec2);

      expect(result).toBe(0);
    });

    it("should handle identical vectors", () => {
      mockClientCosine.mockReturnValueOnce(1);

      const vec1 = [1, 2, 3];
      const vec2 = [1, 2, 3];
      const result = cosine(vec1, vec2);

      expect(result).toBe(1);
    });

    it("should handle orthogonal vectors", () => {
      mockClientCosine.mockReturnValueOnce(0);

      const vec1 = [1, 0];
      const vec2 = [0, 1];
      const result = cosine(vec1, vec2);

      expect(result).toBe(0);
    });
  });
});
