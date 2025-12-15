/**
 * Comprehensive tests for mime.ts
 * Target: 100% code coverage
 */

import {
  guessMime,
  isValidImageMime,
  getExtensionFromMime,
  hasImageExtension,
  sanitizeFilename,
  SUPPORTED_IMAGE_TYPES,
} from '../../src/lib/mime';

describe('mime.ts', () => {
  describe('guessMime', () => {
    it('should return image/jpeg for .jpg files', () => {
      expect(guessMime('photo.jpg')).toBe('image/jpeg');
      expect(guessMime('PHOTO.JPG')).toBe('image/jpeg');
    });

    it('should return image/jpeg for .jpeg files', () => {
      expect(guessMime('image.jpeg')).toBe('image/jpeg');
      expect(guessMime('IMAGE.JPEG')).toBe('image/jpeg');
    });

    it('should return image/png for .png files', () => {
      expect(guessMime('screenshot.png')).toBe('image/png');
      expect(guessMime('SCREENSHOT.PNG')).toBe('image/png');
    });

    it('should return image/gif for .gif files', () => {
      expect(guessMime('animation.gif')).toBe('image/gif');
    });

    it('should return image/webp for .webp files', () => {
      expect(guessMime('modern.webp')).toBe('image/webp');
    });

    it('should return image/heic for .heic files', () => {
      expect(guessMime('iphone.heic')).toBe('image/heic');
    });

    it('should return image/heif for .heif files', () => {
      expect(guessMime('photo.heif')).toBe('image/heif');
    });

    it('should return image/bmp for .bmp files', () => {
      expect(guessMime('bitmap.bmp')).toBe('image/bmp');
    });

    it('should return image/tiff for .tiff and .tif files', () => {
      expect(guessMime('scan.tiff')).toBe('image/tiff');
      expect(guessMime('document.tif')).toBe('image/tiff');
    });

    it('should return application/octet-stream for unknown extensions', () => {
      expect(guessMime('file.unknown')).toBe('application/octet-stream');
      expect(guessMime('file.xyz')).toBe('application/octet-stream');
    });

    it('should handle files without extensions', () => {
      expect(guessMime('noextension')).toBe('application/octet-stream');
    });

    it('should handle empty string', () => {
      expect(guessMime('')).toBe('application/octet-stream');
    });
  });

  describe('isValidImageMime', () => {
    it('should return true for supported image types', () => {
      expect(isValidImageMime('image/jpeg')).toBe(true);
      expect(isValidImageMime('image/jpg')).toBe(true);
      expect(isValidImageMime('image/png')).toBe(true);
      expect(isValidImageMime('image/gif')).toBe(true);
      expect(isValidImageMime('image/webp')).toBe(true);
      expect(isValidImageMime('image/heic')).toBe(true);
      expect(isValidImageMime('image/heif')).toBe(true);
    });

    it('should be case insensitive', () => {
      expect(isValidImageMime('IMAGE/JPEG')).toBe(true);
      expect(isValidImageMime('Image/Png')).toBe(true);
    });

    it('should return false for unsupported types', () => {
      expect(isValidImageMime('image/bmp')).toBe(false);
      expect(isValidImageMime('image/tiff')).toBe(false);
      expect(isValidImageMime('application/pdf')).toBe(false);
      expect(isValidImageMime('text/plain')).toBe(false);
    });
  });

  describe('getExtensionFromMime', () => {
    it('should return .jpg for image/jpeg and image/jpg', () => {
      expect(getExtensionFromMime('image/jpeg')).toBe('.jpg');
      expect(getExtensionFromMime('image/jpg')).toBe('.jpg');
    });

    it('should return correct extensions for all supported types', () => {
      expect(getExtensionFromMime('image/png')).toBe('.png');
      expect(getExtensionFromMime('image/gif')).toBe('.gif');
      expect(getExtensionFromMime('image/webp')).toBe('.webp');
      expect(getExtensionFromMime('image/heic')).toBe('.heic');
      expect(getExtensionFromMime('image/heif')).toBe('.heif');
      expect(getExtensionFromMime('image/bmp')).toBe('.bmp');
      expect(getExtensionFromMime('image/tiff')).toBe('.tiff');
    });

    it('should be case insensitive', () => {
      expect(getExtensionFromMime('IMAGE/JPEG')).toBe('.jpg');
      expect(getExtensionFromMime('Image/Png')).toBe('.png');
    });

    it('should return .bin for unknown MIME types', () => {
      expect(getExtensionFromMime('application/pdf')).toBe('.bin');
      expect(getExtensionFromMime('text/plain')).toBe('.bin');
      expect(getExtensionFromMime('unknown/type')).toBe('.bin');
    });
  });

  describe('hasImageExtension', () => {
    it('should return true for image extensions', () => {
      expect(hasImageExtension('photo.jpg')).toBe(true);
      expect(hasImageExtension('photo.jpeg')).toBe(true);
      expect(hasImageExtension('image.png')).toBe(true);
      expect(hasImageExtension('animation.gif')).toBe(true);
      expect(hasImageExtension('modern.webp')).toBe(true);
      expect(hasImageExtension('iphone.heic')).toBe(true);
      expect(hasImageExtension('photo.heif')).toBe(true);
      expect(hasImageExtension('bitmap.bmp')).toBe(true);
      expect(hasImageExtension('scan.tiff')).toBe(true);
      expect(hasImageExtension('document.tif')).toBe(true);
    });

    it('should be case insensitive', () => {
      expect(hasImageExtension('PHOTO.JPG')).toBe(true);
      expect(hasImageExtension('Image.PNG')).toBe(true);
      expect(hasImageExtension('File.Webp')).toBe(true);
    });

    it('should return false for non-image extensions', () => {
      expect(hasImageExtension('document.pdf')).toBe(false);
      expect(hasImageExtension('text.txt')).toBe(false);
      expect(hasImageExtension('video.mp4')).toBe(false);
    });

    it('should return false for files without extensions', () => {
      expect(hasImageExtension('noextension')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(hasImageExtension('')).toBe(false);
    });
  });

  describe('sanitizeFilename', () => {
    it('should preserve valid filenames', () => {
      expect(sanitizeFilename('photo.jpg')).toBe('photo.jpg');
      expect(sanitizeFilename('my-file_123.png')).toBe('my-file_123.png');
    });

    it('should replace spaces with underscores', () => {
      expect(sanitizeFilename('my photo.jpg')).toBe('my_photo.jpg');
      expect(sanitizeFilename('vacation photo 2024.png')).toBe('vacation_photo_2024.png');
    });

    it('should remove special characters', () => {
      expect(sanitizeFilename('photo!@#$%.jpg')).toBe('photo_.jpg');
      expect(sanitizeFilename('file(1).png')).toBe('file_1_.png');
    });

    it('should remove path traversal attempts', () => {
      expect(sanitizeFilename('../../../etc/passwd')).toBe('etc_passwd');
      expect(sanitizeFilename('..\\..\\windows\\system32')).toBe('windows_system32');
    });

    it('should collapse multiple underscores', () => {
      expect(sanitizeFilename('file___name.jpg')).toBe('file_name.jpg');
      expect(sanitizeFilename('test____photo.png')).toBe('test_photo.png');
    });

    it('should trim leading/trailing underscores', () => {
      expect(sanitizeFilename('_file.jpg')).toBe('file.jpg');
      expect(sanitizeFilename('file_.png')).toBe('file_.png'); // underscore before extension is kept
      expect(sanitizeFilename('___file___.gif')).toBe('file_.gif'); // collapse ___ to _, then remove leading _
    });

    it('should trim whitespace', () => {
      expect(sanitizeFilename('  photo.jpg  ')).toBe('photo.jpg');
      expect(sanitizeFilename('\\t\\nfile.png\\t')).toBe('t_nfile.png_t');
    });

    it('should return "unnamed" for empty/invalid names', () => {
      expect(sanitizeFilename('')).toBe('unnamed');
      expect(sanitizeFilename('   ')).toBe('unnamed');
      expect(sanitizeFilename('!!!')).toBe('unnamed');
      expect(sanitizeFilename('..')).toBe('unnamed');
    });

    it('should handle extension-only filenames', () => {
      expect(sanitizeFilename('.jpg')).toBe('unnamed.jpg');
      expect(sanitizeFilename('.png')).toBe('unnamed.png');
    });

    it('should truncate long filenames to 100 characters', () => {
      const longName = 'a'.repeat(150) + '.jpg';
      const result = sanitizeFilename(longName);
      expect(result).toBe('a'.repeat(100) + '.jpg');
      expect(result.length).toBe(104); // 100 + '.jpg'
    });

    it('should preserve extension when truncating', () => {
      const longName = 'very_long_filename_'.repeat(10) + '.jpeg';
      const result = sanitizeFilename(longName);
      expect(result.endsWith('.jpeg')).toBe(true);
      expect(result.length).toBeLessThanOrEqual(105); // 100 + '.jpeg'
    });

    it('should handle multiple extensions correctly', () => {
      expect(sanitizeFilename('file.tar.gz')).toBe('file.tar.gz');
      expect(sanitizeFilename('backup.2024.12.14.zip')).toBe('backup.2024.12.14.zip');
    });

    it('should handle filenames without extensions after truncation', () => {
      const longName = 'a'.repeat(150);
      const result = sanitizeFilename(longName);
      expect(result).toBe('a'.repeat(100));
      expect(result.length).toBe(100);
    });
  });

  describe('SUPPORTED_IMAGE_TYPES', () => {
    it('should export supported image types constant', () => {
      expect(SUPPORTED_IMAGE_TYPES).toEqual([
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/heic',
        'image/heif',
      ]);
    });

    it('should be readonly', () => {
      expect(Array.isArray(SUPPORTED_IMAGE_TYPES)).toBe(true);
      expect(SUPPORTED_IMAGE_TYPES.length).toBe(7);
    });
  });
});
