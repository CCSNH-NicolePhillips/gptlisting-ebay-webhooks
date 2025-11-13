// Tests for MIME type utilities

import {
  guessMime,
  hasImageExtension,
  isValidImageMime,
  getExtensionFromMime,
  sanitizeFilename,
} from "../../src/lib/mime.js";

describe("MIME Type Utilities", () => {
  describe("guessMime", () => {
    test("recognizes common image extensions", () => {
      expect(guessMime("photo.jpg")).toBe("image/jpeg");
      expect(guessMime("photo.jpeg")).toBe("image/jpeg");
      expect(guessMime("photo.JPG")).toBe("image/jpeg");
      expect(guessMime("photo.png")).toBe("image/png");
      expect(guessMime("photo.PNG")).toBe("image/png");
      expect(guessMime("photo.gif")).toBe("image/gif");
      expect(guessMime("photo.webp")).toBe("image/webp");
      expect(guessMime("photo.heic")).toBe("image/heic");
    });

    test("handles paths with directories", () => {
      expect(guessMime("/path/to/photo.jpg")).toBe("image/jpeg");
      expect(guessMime("C:\\Users\\file.png")).toBe("image/png");
    });

    test("returns default for unknown extensions", () => {
      expect(guessMime("file.txt")).toBe("application/octet-stream");
      expect(guessMime("file.pdf")).toBe("application/octet-stream");
      expect(guessMime("noextension")).toBe("application/octet-stream");
    });

    test("handles edge cases", () => {
      expect(guessMime("")).toBe("application/octet-stream");
      expect(guessMime(".jpg")).toBe("image/jpeg");
    });
  });

  describe("hasImageExtension", () => {
    test("returns true for image files", () => {
      expect(hasImageExtension("photo.jpg")).toBe(true);
      expect(hasImageExtension("photo.jpeg")).toBe(true);
      expect(hasImageExtension("photo.png")).toBe(true);
      expect(hasImageExtension("photo.gif")).toBe(true);
      expect(hasImageExtension("PHOTO.JPG")).toBe(true);
    });

    test("returns false for non-image files", () => {
      expect(hasImageExtension("document.pdf")).toBe(false);
      expect(hasImageExtension("data.json")).toBe(false);
      expect(hasImageExtension("video.mp4")).toBe(false);
      expect(hasImageExtension("noextension")).toBe(false);
    });
  });

  describe("isValidImageMime", () => {
    test("returns true for image MIME types", () => {
      expect(isValidImageMime("image/jpeg")).toBe(true);
      expect(isValidImageMime("image/png")).toBe(true);
      expect(isValidImageMime("image/gif")).toBe(true);
      expect(isValidImageMime("image/webp")).toBe(true);
      expect(isValidImageMime("IMAGE/JPEG")).toBe(true);
    });

    test("returns false for non-image MIME types", () => {
      expect(isValidImageMime("application/pdf")).toBe(false);
      expect(isValidImageMime("text/plain")).toBe(false);
      expect(isValidImageMime("video/mp4")).toBe(false);
      expect(isValidImageMime("")).toBe(false);
    });
  });

  describe("getExtensionFromMime", () => {
    test("returns correct extensions for common MIME types", () => {
      expect(getExtensionFromMime("image/jpeg")).toBe(".jpg");
      expect(getExtensionFromMime("image/png")).toBe(".png");
      expect(getExtensionFromMime("image/gif")).toBe(".gif");
      expect(getExtensionFromMime("image/webp")).toBe(".webp");
      expect(getExtensionFromMime("image/heic")).toBe(".heic");
    });

    test("returns default for unknown MIME types", () => {
      expect(getExtensionFromMime("application/pdf")).toBe(".bin");
      expect(getExtensionFromMime("unknown/type")).toBe(".bin");
    });

    test("handles case insensitivity", () => {
      expect(getExtensionFromMime("IMAGE/JPEG")).toBe(".jpg");
      expect(getExtensionFromMime("Image/Png")).toBe(".png");
    });
  });

  describe("sanitizeFilename", () => {
    test("preserves safe filenames", () => {
      expect(sanitizeFilename("photo-123.jpg")).toBe("photo-123.jpg");
      expect(sanitizeFilename("my_file.png")).toBe("my_file.png");
      expect(sanitizeFilename("file.2024.jpeg")).toBe("file.2024.jpeg");
    });

    test("removes unsafe characters", () => {
      expect(sanitizeFilename("photo/../../../etc/passwd.jpg")).not.toContain("..");
      expect(sanitizeFilename("file<script>.jpg")).not.toContain("<");
      expect(sanitizeFilename("file with spaces.jpg")).not.toContain(" ");
    });

    test("truncates long filenames", () => {
      const longName = "a".repeat(300) + ".jpg";
      const sanitized = sanitizeFilename(longName);
      expect(sanitized.length).toBeLessThanOrEqual(255);
      expect(sanitized).toMatch(/\.jpg$/);
    });

    test("handles edge cases", () => {
      expect(sanitizeFilename("")).toBe("unnamed");
      expect(sanitizeFilename("   ")).toBe("unnamed");
      expect(sanitizeFilename(".jpg")).toBe("unnamed.jpg");
    });
  });
});
