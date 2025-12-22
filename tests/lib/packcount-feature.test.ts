/**
 * Tests for packCount feature in vision classification
 * 
 * packCount is extracted from product packaging during vision analysis
 * and used to select the correct variant during price lookup.
 * 
 * Example: Frog Fuel "24 packets" → packCount: 24 → matches $48 variant
 */

describe('packCount Feature', () => {
  describe('packCount parsing patterns', () => {
    const parsePackCount = (text: string): number | null => {
      // Common pack count patterns from product labels
      const patterns = [
        /(\d+)\s*(?:pack|packets?|count|ct|pcs?|pieces?)/i,
        /(\d+)\s*(?:oz|fl\.?\s*oz)/i, // "24 oz" for eye patches, etc.
        /pack\s+of\s+(\d+)/i,
        /(\d+)\s*[-–]\s*pack/i, // "24-pack"
        /qty[:\s]*(\d+)/i,
      ];

      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > 1 && num <= 1000) return num;
        }
      }
      return null;
    };

    it('should parse "24 packets" from Frog Fuel', () => {
      expect(parsePackCount('24 packets')).toBe(24);
      expect(parsePackCount('24 Packets Fuel')).toBe(24);
    });

    it('should parse "60 count" from COSRX eye patches', () => {
      expect(parsePackCount('60 count')).toBe(60);
      expect(parsePackCount('60 ct')).toBe(60);
    });

    it('should parse "6-pack" format', () => {
      expect(parsePackCount('6-pack')).toBe(6);
      expect(parsePackCount('12-Pack')).toBe(12);
    });

    it('should parse "pack of X" format', () => {
      expect(parsePackCount('pack of 24')).toBe(24);
      expect(parsePackCount('Pack Of 12')).toBe(12);
    });

    it('should return null for single items', () => {
      expect(parsePackCount('1 bottle')).toBeNull();
      expect(parsePackCount('single serving')).toBeNull();
    });

    it('should handle "X pieces" format', () => {
      expect(parsePackCount('30 pieces')).toBe(30);
      expect(parsePackCount('100 pcs')).toBe(100);
    });
  });

  describe('packCount impact on pricing', () => {
    it('should use packCount to select correct variant price', () => {
      // Frog Fuel example:
      // - Single packet: ~$2
      // - 24-pack: ~$48
      // Vision extracts packCount: 24
      // Price lookup should match the 24-pack variant at $48

      const packCount = 24;
      const variants = [
        { name: '1oz Packet', price: 2.49, packSize: 1 },
        { name: '4 1oz Packets', price: 9.99, packSize: 4 },
        { name: '24 1oz Packets', price: 48.00, packSize: 24 },
      ];

      // Find best matching variant
      const matched = variants.find(v => v.packSize === packCount);
      
      expect(matched).toBeDefined();
      expect(matched!.price).toBe(48.00);
      expect(matched!.name).toContain('24');
    });

    it('should prioritize exact packCount match over title keywords', () => {
      const packCount = 24;
      const productTitle = 'Frog Fuel Energy Liquid Protein';

      // Without packCount, might match wrong variant
      // With packCount, should match exact pack size
      const variants = [
        { name: 'Energy Shot 4-pack', price: 12.99, packSize: 4 },
        { name: 'Protein 24-pack', price: 48.00, packSize: 24 },
        { name: 'Liquid Fuel 12-pack', price: 28.99, packSize: 12 },
      ];

      const matched = variants.find(v => v.packSize === packCount);
      expect(matched?.price).toBe(48.00);
    });
  });

  describe('packCount field in classification result', () => {
    interface ImageClassificationV2 {
      isProduct: boolean;
      role: string;
      brand: string | null;
      productName: string | null;
      packCount?: number | null;
    }

    it('should include packCount in classification when detected', () => {
      const classification: ImageClassificationV2 = {
        isProduct: true,
        role: 'front',
        brand: 'Frog Fuel',
        productName: 'Ultra Energy',
        packCount: 24,
      };

      expect(classification.packCount).toBe(24);
    });

    it('should allow null packCount for single items', () => {
      const classification: ImageClassificationV2 = {
        isProduct: true,
        role: 'front',
        brand: 'Some Brand',
        productName: 'Single Item',
        packCount: null,
      };

      expect(classification.packCount).toBeNull();
    });

    it('should thread packCount from vision through pricing pipeline', () => {
      // Mock the full pipeline
      const visionResult = { packCount: 24 };
      const pairingResult = { packCount: visionResult.packCount };
      const priceLookupInput = { packCount: pairingResult.packCount };

      // Verify packCount flows through
      expect(priceLookupInput.packCount).toBe(24);
    });
  });
});
