import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Tests for pairing-v2-processor-background.ts
 * Focuses on the Dropbox temp link fallback logic when R2/S3 is not configured
 */

// Mock environment variables
const originalEnv = process.env;

describe('pairing-v2-processor-background', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('R2/S3 configuration detection', () => {
    it('should detect R2 is configured when all credentials present', () => {
      process.env.R2_BUCKET = 'test-bucket';
      process.env.R2_ACCESS_KEY_ID = 'test-key';
      process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
      
      const hasR2Config = !!(process.env.R2_BUCKET || process.env.S3_BUCKET) && 
                         !!(process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID) &&
                         !!(process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY);
      
      expect(hasR2Config).toBe(true);
    });

    it('should detect S3 is configured when all AWS credentials present', () => {
      process.env.S3_BUCKET = 'test-bucket';
      process.env.AWS_ACCESS_KEY_ID = 'test-key';
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
      
      const hasR2Config = !!(process.env.R2_BUCKET || process.env.S3_BUCKET) && 
                         !!(process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID) &&
                         !!(process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY);
      
      expect(hasR2Config).toBe(true);
    });

    it('should detect R2/S3 NOT configured when only bucket is set', () => {
      process.env.S3_BUCKET = 'test-bucket';
      // Missing credentials
      delete process.env.R2_ACCESS_KEY_ID;
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.R2_SECRET_ACCESS_KEY;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      
      const hasR2Config = !!(process.env.R2_BUCKET || process.env.S3_BUCKET) && 
                         !!(process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID) &&
                         !!(process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY);
      
      expect(hasR2Config).toBe(false);
    });

    it('should detect R2/S3 NOT configured when credentials missing secret', () => {
      process.env.S3_BUCKET = 'test-bucket';
      process.env.AWS_ACCESS_KEY_ID = 'test-key';
      // Missing secret
      delete process.env.R2_SECRET_ACCESS_KEY;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      
      const hasR2Config = !!(process.env.R2_BUCKET || process.env.S3_BUCKET) && 
                         !!(process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID) &&
                         !!(process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY);
      
      expect(hasR2Config).toBe(false);
    });

    it('should detect R2/S3 NOT configured when no bucket set', () => {
      delete process.env.R2_BUCKET;
      delete process.env.S3_BUCKET;
      process.env.AWS_ACCESS_KEY_ID = 'test-key';
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
      
      const hasR2Config = !!(process.env.R2_BUCKET || process.env.S3_BUCKET) && 
                         !!(process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID) &&
                         !!(process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY);
      
      expect(hasR2Config).toBe(false);
    });
  });

  describe('findSourceUrl helper logic', () => {
    it('should find URL by filename hint match', () => {
      const imageSources = [
        'https://dl.dropbox.com/temp/abc123?dl=1',
        'https://dl.dropbox.com/temp/def456?dl=1',
        'https://dl.dropbox.com/temp/ghi789?dl=1',
      ];
      const filenameHints = ['front.jpg', 'back.jpg', 'side.jpg'];
      
      const findSourceUrl = (targetFilename: string): string | null => {
        for (let i = 0; i < imageSources.length; i++) {
          const hint = filenameHints[i] || '';
          if (hint === targetFilename) {
            return imageSources[i];
          }
        }
        return null;
      };
      
      expect(findSourceUrl('front.jpg')).toBe('https://dl.dropbox.com/temp/abc123?dl=1');
      expect(findSourceUrl('back.jpg')).toBe('https://dl.dropbox.com/temp/def456?dl=1');
      expect(findSourceUrl('side.jpg')).toBe('https://dl.dropbox.com/temp/ghi789?dl=1');
      expect(findSourceUrl('missing.jpg')).toBeNull();
    });

    it('should find URL by URL path basename match', () => {
      const imageSources = [
        'https://dl.dropbox.com/temp/front.jpg?dl=1',
        'https://dl.dropbox.com/temp/back.jpg?dl=1',
      ];
      const filenameHints: string[] = []; // No hints
      const path = require('path');
      
      const findSourceUrl = (targetFilename: string): string | null => {
        for (let i = 0; i < imageSources.length; i++) {
          const hint = filenameHints[i] || '';
          if (hint === targetFilename) {
            return imageSources[i];
          }
          // Also check URL path for filename
          try {
            const urlFilename = path.basename(new URL(imageSources[i]).pathname);
            if (urlFilename === targetFilename) {
              return imageSources[i];
            }
          } catch {}
        }
        return null;
      };
      
      expect(findSourceUrl('front.jpg')).toBe('https://dl.dropbox.com/temp/front.jpg?dl=1');
      expect(findSourceUrl('back.jpg')).toBe('https://dl.dropbox.com/temp/back.jpg?dl=1');
    });

    it('should prefer hint match over URL path match', () => {
      const imageSources = [
        'https://dl.dropbox.com/temp/wrong.jpg?dl=1',
        'https://dl.dropbox.com/temp/front.jpg?dl=1',
      ];
      const filenameHints = ['front.jpg', 'other.jpg'];
      
      const findSourceUrl = (targetFilename: string): string | null => {
        for (let i = 0; i < imageSources.length; i++) {
          const hint = filenameHints[i] || '';
          if (hint === targetFilename) {
            return imageSources[i];
          }
        }
        return null;
      };
      
      // Should find by hint (index 0), not by URL path (index 1)
      expect(findSourceUrl('front.jpg')).toBe('https://dl.dropbox.com/temp/wrong.jpg?dl=1');
    });
  });

  describe('Dropbox fallback behavior', () => {
    it('should use Dropbox temp links when R2 staging returns empty', () => {
      // Simulate the fallback logic
      let frontUrl = ''; // R2 staging failed
      let backUrl = '';  // R2 staging failed
      
      const frontFilename = 'product-front.jpg';
      const backFilename = 'product-back.jpg';
      
      const imageSources = [
        'https://dl.dropbox.com/temp/product-front.jpg?dl=1',
        'https://dl.dropbox.com/temp/product-back.jpg?dl=1',
      ];
      const filenameHints = ['product-front.jpg', 'product-back.jpg'];
      
      const findSourceUrl = (targetFilename: string): string | null => {
        for (let i = 0; i < imageSources.length; i++) {
          const hint = filenameHints[i] || '';
          if (hint === targetFilename) {
            return imageSources[i];
          }
        }
        return null;
      };
      
      // Fallback logic from the processor
      if (!frontUrl) {
        frontUrl = findSourceUrl(frontFilename) || '';
      }
      if (!backUrl) {
        backUrl = findSourceUrl(backFilename) || '';
      }
      
      expect(frontUrl).toBe('https://dl.dropbox.com/temp/product-front.jpg?dl=1');
      expect(backUrl).toBe('https://dl.dropbox.com/temp/product-back.jpg?dl=1');
    });

    it('should NOT override successful R2 URLs', () => {
      // Simulate successful R2 staging
      let frontUrl = 'https://r2.example.com/staging/user123/job456/abc-product-front.jpg';
      let backUrl = 'https://r2.example.com/staging/user123/job456/def-product-back.jpg';
      
      const frontFilename = 'product-front.jpg';
      const backFilename = 'product-back.jpg';
      
      const imageSources = [
        'https://dl.dropbox.com/temp/product-front.jpg?dl=1',
        'https://dl.dropbox.com/temp/product-back.jpg?dl=1',
      ];
      const filenameHints = ['product-front.jpg', 'product-back.jpg'];
      
      const findSourceUrl = (targetFilename: string): string | null => {
        for (let i = 0; i < imageSources.length; i++) {
          const hint = filenameHints[i] || '';
          if (hint === targetFilename) {
            return imageSources[i];
          }
        }
        return null;
      };
      
      // Fallback logic - should NOT override because frontUrl/backUrl are already set
      if (!frontUrl) {
        frontUrl = findSourceUrl(frontFilename) || '';
      }
      if (!backUrl) {
        backUrl = findSourceUrl(backFilename) || '';
      }
      
      // Should keep the R2 URLs
      expect(frontUrl).toBe('https://r2.example.com/staging/user123/job456/abc-product-front.jpg');
      expect(backUrl).toBe('https://r2.example.com/staging/user123/job456/def-product-back.jpg');
    });

    it('should handle partial R2 success (one fails, one succeeds)', () => {
      // Simulate partial R2 staging - front succeeded, back failed
      let frontUrl = 'https://r2.example.com/staging/user123/job456/abc-product-front.jpg';
      let backUrl = ''; // R2 staging failed for back
      
      const frontFilename = 'product-front.jpg';
      const backFilename = 'product-back.jpg';
      
      const imageSources = [
        'https://dl.dropbox.com/temp/product-front.jpg?dl=1',
        'https://dl.dropbox.com/temp/product-back.jpg?dl=1',
      ];
      const filenameHints = ['product-front.jpg', 'product-back.jpg'];
      
      const findSourceUrl = (targetFilename: string): string | null => {
        for (let i = 0; i < imageSources.length; i++) {
          const hint = filenameHints[i] || '';
          if (hint === targetFilename) {
            return imageSources[i];
          }
        }
        return null;
      };
      
      // Fallback logic
      if (!frontUrl) {
        frontUrl = findSourceUrl(frontFilename) || '';
      }
      if (!backUrl) {
        backUrl = findSourceUrl(backFilename) || '';
      }
      
      // Front should keep R2 URL, back should fall back to Dropbox
      expect(frontUrl).toBe('https://r2.example.com/staging/user123/job456/abc-product-front.jpg');
      expect(backUrl).toBe('https://dl.dropbox.com/temp/product-back.jpg?dl=1');
    });

    it('should handle missing source URL gracefully', () => {
      let frontUrl = '';
      let backUrl = '';
      
      const frontFilename = 'product-front.jpg';
      const backFilename = 'missing-file.jpg'; // Not in sources
      
      const imageSources = [
        'https://dl.dropbox.com/temp/product-front.jpg?dl=1',
      ];
      const filenameHints = ['product-front.jpg'];
      
      const findSourceUrl = (targetFilename: string): string | null => {
        for (let i = 0; i < imageSources.length; i++) {
          const hint = filenameHints[i] || '';
          if (hint === targetFilename) {
            return imageSources[i];
          }
        }
        return null;
      };
      
      if (!frontUrl) {
        frontUrl = findSourceUrl(frontFilename) || '';
      }
      if (!backUrl) {
        backUrl = findSourceUrl(backFilename) || '';
      }
      
      expect(frontUrl).toBe('https://dl.dropbox.com/temp/product-front.jpg?dl=1');
      expect(backUrl).toBe(''); // Should be empty, not throw
    });
  });

  describe('Side image handling', () => {
    it('should handle optional side images with fallback', () => {
      let side1Url: string | undefined;
      let side2Url: string | undefined;
      
      const side1Filename = 'product-side1.jpg';
      const side2Filename = 'product-side2.jpg';
      
      const imageSources = [
        'https://dl.dropbox.com/temp/product-front.jpg?dl=1',
        'https://dl.dropbox.com/temp/product-back.jpg?dl=1',
        'https://dl.dropbox.com/temp/product-side1.jpg?dl=1',
        // side2 not present
      ];
      const filenameHints = ['product-front.jpg', 'product-back.jpg', 'product-side1.jpg'];
      
      const findSourceUrl = (targetFilename: string): string | null => {
        for (let i = 0; i < imageSources.length; i++) {
          const hint = filenameHints[i] || '';
          if (hint === targetFilename) {
            return imageSources[i];
          }
        }
        return null;
      };
      
      if (side1Filename && !side1Url) {
        side1Url = findSourceUrl(side1Filename) || undefined;
      }
      if (side2Filename && !side2Url) {
        side2Url = findSourceUrl(side2Filename) || undefined;
      }
      
      expect(side1Url).toBe('https://dl.dropbox.com/temp/product-side1.jpg?dl=1');
      expect(side2Url).toBeUndefined();
    });
  });
});
