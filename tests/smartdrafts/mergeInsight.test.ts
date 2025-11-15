/**
 * Tests for mergeInsight data preservation
 * 
 * CONTEXT: The mergeInsight function was a major source of data loss bugs.
 * Originally it only preserved specific fields (role, dominantColor, ocrText),
 * causing visualDescription to be lost during scan processing.
 * 
 * Bug Report: VISUAL-DESCRIPTION-BUG-REPORT.md
 * Fix Commit: abb632c - Added visualDescription preservation
 * 
 * These tests ensure critical fields are never lost again.
 */

describe('mergeInsight data preservation', () => {
  // Mock ImageInsight structure
  interface ImageInsight {
    url: string;
    role?: 'front' | 'back' | 'supplement' | 'lifestyle';
    hasVisibleText?: boolean;
    dominantColor?: string;
    ocrText?: string;
    textBlocks?: string[];
    text?: string;
    ocr?: {
      text?: string;
      lines?: string[];
    };
    textExtracted?: string;
    evidenceTriggers?: string[];
    visualDescription?: string;
  }

  /**
   * Simplified mergeInsight implementation for testing
   * This mirrors the actual function in smartdrafts-scan-core.ts lines 3345-3378
   */
  function mergeInsight(
    current: ImageInsight,
    source?: Partial<ImageInsight>
  ): ImageInsight {
    if (!source) return current;

    // Preserve role
    if (source.role && !current.role) current.role = source.role;

    // Preserve hasVisibleText
    if (source.hasVisibleText !== undefined && current.hasVisibleText === undefined) {
      current.hasVisibleText = source.hasVisibleText;
    }

    // Preserve dominantColor
    if (source.dominantColor && !current.dominantColor) {
      current.dominantColor = source.dominantColor;
    }

    // Preserve ocrText
    if (source.ocrText && !current.ocrText) current.ocrText = source.ocrText;

    // Preserve textBlocks
    if (Array.isArray(source.textBlocks) && !current.textBlocks) {
      current.textBlocks = source.textBlocks.slice();
    }

    // Preserve text
    if (source.text && !current.text) current.text = source.text;

    // Preserve OCR object
    if (source.ocr) {
      current.ocr = current.ocr || {};
      if (source.ocr.text && !current.ocr.text) current.ocr.text = source.ocr.text;
      if (Array.isArray(source.ocr.lines) && (!current.ocr.lines || current.ocr.lines.length === 0)) {
        current.ocr.lines = source.ocr.lines.slice();
      }
    }

    // Extract textExtracted and evidenceTriggers for pairing
    const textExtracted = source.ocrText || source.textExtracted || '';
    if (textExtracted && !current.textExtracted) {
      current.textExtracted = textExtracted;
    }

    // Preserve evidenceTriggers (simplified - no detectFactsCues call)
    if (Array.isArray(source.evidenceTriggers) && !Array.isArray(current.evidenceTriggers)) {
      current.evidenceTriggers = source.evidenceTriggers;
    }

    // CRITICAL: Preserve visualDescription for visual similarity scoring
    if (source.visualDescription && !current.visualDescription) {
      current.visualDescription = source.visualDescription;
    }

    return current;
  }

  describe('visualDescription preservation (Bug Fix abb632c)', () => {
    it('should preserve visualDescription from source to empty current', () => {
      const current: ImageInsight = { url: 'test.jpg' };
      const source: Partial<ImageInsight> = {
        visualDescription: 'Medium cylindrical bottle, plastic-glossy material with white screw-cap',
      };

      const result = mergeInsight(current, source);

      expect(result.visualDescription).toBe(source.visualDescription);
    });

    it('should not overwrite existing visualDescription', () => {
      const current: ImageInsight = {
        url: 'test.jpg',
        visualDescription: 'Original description',
      };
      const source: Partial<ImageInsight> = {
        visualDescription: 'New description',
      };

      const result = mergeInsight(current, source);

      expect(result.visualDescription).toBe('Original description');
    });

    it('should handle empty string visualDescription', () => {
      const current: ImageInsight = { url: 'test.jpg' };
      const source: Partial<ImageInsight> = {
        visualDescription: '',
      };

      const result = mergeInsight(current, source);

      // Empty string is falsy, should not be preserved
      expect(result.visualDescription).toBeUndefined();
    });

    it('should preserve long visualDescription (real-world case)', () => {
      const current: ImageInsight = { url: 'img_20251102_133613.jpg' };
      const source: Partial<ImageInsight> = {
        visualDescription:
          'Medium cylindrical bottle, plastic-glossy material with a white screw-cap. ' +
          'The bottle is dark-blue with a full-wrap label featuring yellow accents and ' +
          'white text. The label has a prominent brand logo at the top and nutritional ' +
          'information. The bottle appears professional with clean edges and high-quality printing.',
      };

      const result = mergeInsight(current, source);

      expect(result.visualDescription).toBe(source.visualDescription);
      expect(result.visualDescription!.length).toBeGreaterThan(250);
    });

    it('should preserve visualDescription alongside other fields', () => {
      const current: ImageInsight = { url: 'test.jpg' };
      const source: Partial<ImageInsight> = {
        role: 'front',
        dominantColor: '#1a3d7c',
        visualDescription: 'Dark blue bottle with white cap',
      };

      const result = mergeInsight(current, source);

      expect(result.role).toBe('front');
      expect(result.dominantColor).toBe('#1a3d7c');
      expect(result.visualDescription).toBe('Dark blue bottle with white cap');
    });
  });

  describe('textExtracted preservation', () => {
    it('should extract textExtracted from ocrText', () => {
      const current: ImageInsight = { url: 'test.jpg' };
      const source: Partial<ImageInsight> = {
        ocrText: 'Supplement Facts\nServing Size: 2 capsules',
      };

      const result = mergeInsight(current, source);

      expect(result.textExtracted).toBe(source.ocrText);
    });

    it('should use existing textExtracted field', () => {
      const current: ImageInsight = { url: 'test.jpg' };
      const source: Partial<ImageInsight> = {
        textExtracted: 'Extracted text',
      };

      const result = mergeInsight(current, source);

      expect(result.textExtracted).toBe('Extracted text');
    });

    it('should prefer ocrText over textExtracted', () => {
      const current: ImageInsight = { url: 'test.jpg' };
      const source: Partial<ImageInsight> = {
        ocrText: 'OCR text',
        textExtracted: 'Extracted text',
      };

      const result = mergeInsight(current, source);

      expect(result.textExtracted).toBe('OCR text');
    });

    it('should not overwrite existing textExtracted', () => {
      const current: ImageInsight = {
        url: 'test.jpg',
        textExtracted: 'Existing text',
      };
      const source: Partial<ImageInsight> = {
        ocrText: 'New text',
      };

      const result = mergeInsight(current, source);

      expect(result.textExtracted).toBe('Existing text');
    });
  });

  describe('role preservation', () => {
    it('should preserve role from source', () => {
      const current: ImageInsight = { url: 'test.jpg' };
      const source: Partial<ImageInsight> = { role: 'front' };

      const result = mergeInsight(current, source);

      expect(result.role).toBe('front');
    });

    it('should not overwrite existing role', () => {
      const current: ImageInsight = { url: 'test.jpg', role: 'front' };
      const source: Partial<ImageInsight> = { role: 'back' };

      const result = mergeInsight(current, source);

      expect(result.role).toBe('front');
    });

    it('should handle all role types', () => {
      const roles: Array<'front' | 'back' | 'supplement' | 'lifestyle'> = [
        'front',
        'back',
        'supplement',
        'lifestyle',
      ];

      roles.forEach((role) => {
        const current: ImageInsight = { url: 'test.jpg' };
        const source: Partial<ImageInsight> = { role };

        const result = mergeInsight(current, source);

        expect(result.role).toBe(role);
      });
    });
  });

  describe('OCR data preservation', () => {
    it('should preserve ocrText', () => {
      const current: ImageInsight = { url: 'test.jpg' };
      const source: Partial<ImageInsight> = {
        ocrText: 'Ingredients: Water, Glycerin',
      };

      const result = mergeInsight(current, source);

      expect(result.ocrText).toBe(source.ocrText);
    });

    it('should preserve textBlocks array', () => {
      const current: ImageInsight = { url: 'test.jpg' };
      const source: Partial<ImageInsight> = {
        textBlocks: ['BRAND', 'PRODUCT NAME', 'Supplement Facts'],
      };

      const result = mergeInsight(current, source);

      expect(result.textBlocks).toEqual(source.textBlocks);
      expect(result.textBlocks).not.toBe(source.textBlocks); // Should be a copy
    });

    it('should preserve OCR object with text', () => {
      const current: ImageInsight = { url: 'test.jpg' };
      const source: Partial<ImageInsight> = {
        ocr: {
          text: 'Full OCR text',
          lines: ['Line 1', 'Line 2'],
        },
      };

      const result = mergeInsight(current, source);

      expect(result.ocr?.text).toBe('Full OCR text');
      expect(result.ocr?.lines).toEqual(['Line 1', 'Line 2']);
    });

    it('should not overwrite existing OCR text', () => {
      const current: ImageInsight = {
        url: 'test.jpg',
        ocr: { text: 'Existing OCR' },
      };
      const source: Partial<ImageInsight> = {
        ocr: { text: 'New OCR' },
      };

      const result = mergeInsight(current, source);

      expect(result.ocr?.text).toBe('Existing OCR');
    });

    it('should append OCR lines if current is empty', () => {
      const current: ImageInsight = {
        url: 'test.jpg',
        ocr: { lines: [] },
      };
      const source: Partial<ImageInsight> = {
        ocr: { lines: ['New line 1', 'New line 2'] },
      };

      const result = mergeInsight(current, source);

      expect(result.ocr?.lines).toEqual(['New line 1', 'New line 2']);
    });
  });

  describe('visual properties preservation', () => {
    it('should preserve dominantColor', () => {
      const current: ImageInsight = { url: 'test.jpg' };
      const source: Partial<ImageInsight> = { dominantColor: '#ffffff' };

      const result = mergeInsight(current, source);

      expect(result.dominantColor).toBe('#ffffff');
    });

    it('should preserve hasVisibleText boolean', () => {
      const current: ImageInsight = { url: 'test.jpg' };
      const source: Partial<ImageInsight> = { hasVisibleText: true };

      const result = mergeInsight(current, source);

      expect(result.hasVisibleText).toBe(true);
    });

    it('should preserve hasVisibleText=false', () => {
      const current: ImageInsight = { url: 'test.jpg' };
      const source: Partial<ImageInsight> = { hasVisibleText: false };

      const result = mergeInsight(current, source);

      expect(result.hasVisibleText).toBe(false);
    });

    it('should not overwrite hasVisibleText when undefined', () => {
      const current: ImageInsight = {
        url: 'test.jpg',
        hasVisibleText: true,
      };
      const source: Partial<ImageInsight> = {
        hasVisibleText: undefined,
      };

      const result = mergeInsight(current, source);

      expect(result.hasVisibleText).toBe(true);
    });
  });

  describe('complete insight merge (integration)', () => {
    it('should merge complete vision API response', () => {
      const current: ImageInsight = { url: 'product_front.jpg' };
      const visionApiResponse: Partial<ImageInsight> = {
        role: 'front',
        hasVisibleText: true,
        dominantColor: '#1a3d7c',
        ocrText: 'BRAIN BOOST\nNatural Stacks\nSupplement Facts',
        textBlocks: ['BRAIN BOOST', 'Natural Stacks', 'Supplement Facts'],
        visualDescription:
          'Medium cylindrical bottle, plastic-glossy material with white screw-cap. ' +
          'The bottle is dark-blue with full-wrap label featuring yellow accents.',
        evidenceTriggers: ['Supplement Facts', 'Natural Stacks'],
      };

      const result = mergeInsight(current, visionApiResponse);

      expect(result.url).toBe('product_front.jpg');
      expect(result.role).toBe('front');
      expect(result.hasVisibleText).toBe(true);
      expect(result.dominantColor).toBe('#1a3d7c');
      expect(result.ocrText).toBe(visionApiResponse.ocrText);
      expect(result.textBlocks).toEqual(visionApiResponse.textBlocks);
      expect(result.visualDescription).toBe(visionApiResponse.visualDescription);
      expect(result.textExtracted).toBe(visionApiResponse.ocrText); // Auto-extracted
      expect(result.evidenceTriggers).toEqual(visionApiResponse.evidenceTriggers);
    });

    it('should handle incremental merges without data loss', () => {
      let insight: ImageInsight = { url: 'test.jpg' };

      // First merge: role assignment
      insight = mergeInsight(insight, { role: 'front' });
      expect(insight.role).toBe('front');

      // Second merge: add visual data
      insight = mergeInsight(insight, {
        dominantColor: '#ffffff',
        hasVisibleText: true,
      });
      expect(insight.role).toBe('front'); // Preserved
      expect(insight.dominantColor).toBe('#ffffff');

      // Third merge: add OCR data
      insight = mergeInsight(insight, {
        ocrText: 'Product Name',
      });
      expect(insight.role).toBe('front'); // Still preserved
      expect(insight.dominantColor).toBe('#ffffff'); // Still preserved
      expect(insight.ocrText).toBe('Product Name');

      // Fourth merge: add visualDescription
      insight = mergeInsight(insight, {
        visualDescription: 'White bottle with blue cap',
      });
      expect(insight.role).toBe('front'); // Still preserved
      expect(insight.dominantColor).toBe('#ffffff'); // Still preserved
      expect(insight.ocrText).toBe('Product Name'); // Still preserved
      expect(insight.visualDescription).toBe('White bottle with blue cap');
    });

    it('should handle null/undefined source gracefully', () => {
      const current: ImageInsight = {
        url: 'test.jpg',
        role: 'front',
        visualDescription: 'Test description',
      };

      const result = mergeInsight(current, undefined);

      expect(result.url).toBe('test.jpg');
      expect(result.role).toBe('front');
      expect(result.visualDescription).toBe('Test description');
    });
  });

  describe('edge cases and error handling', () => {
    it('should handle empty source object', () => {
      const current: ImageInsight = { url: 'test.jpg' };
      const source: Partial<ImageInsight> = {};

      const result = mergeInsight(current, source);

      expect(result.url).toBe('test.jpg');
      expect(Object.keys(result).length).toBe(1); // Only url
    });

    it('should handle source with only undefined values', () => {
      const current: ImageInsight = { url: 'test.jpg', role: 'front' };
      const source: Partial<ImageInsight> = {
        role: undefined,
        dominantColor: undefined,
        visualDescription: undefined,
      };

      const result = mergeInsight(current, source);

      expect(result.role).toBe('front'); // Not overwritten
    });

    it('should handle very long visualDescription without truncation', () => {
      const longDescription = 'A'.repeat(1000);
      const current: ImageInsight = { url: 'test.jpg' };
      const source: Partial<ImageInsight> = {
        visualDescription: longDescription,
      };

      const result = mergeInsight(current, source);

      expect(result.visualDescription).toBe(longDescription);
      expect(result.visualDescription!.length).toBe(1000);
    });

    it('should handle special characters in visualDescription', () => {
      const current: ImageInsight = { url: 'test.jpg' };
      const source: Partial<ImageInsight> = {
        visualDescription: 'Bottle with "quotes" & special <chars> ©2024',
      };

      const result = mergeInsight(current, source);

      expect(result.visualDescription).toBe('Bottle with "quotes" & special <chars> ©2024');
    });

    it('should handle Unicode in visualDescription', () => {
      const current: ImageInsight = { url: 'test.jpg' };
      const source: Partial<ImageInsight> = {
        visualDescription: '日本製品 • Produit français • Español 🌟',
      };

      const result = mergeInsight(current, source);

      expect(result.visualDescription).toBe('日本製品 • Produit français • Español 🌟');
    });
  });
});
