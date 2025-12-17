/**
 * Tests for Amazon shipping price extraction - Phase 3
 * 
 * PURPOSE: Verify shipping cost parsing from Amazon HTML
 * 
 * ACCEPTANCE CRITERIA:
 * ✅ Existing callers still work (backward compatibility)
 * ✅ For "free shipping" pages, shipping is explicitly 0
 * ✅ For "paid shipping" pages, shipping is parsed when present
 * ✅ If shipping cannot be found, set amazonShippingPrice = 0 AND shippingEvidence = 'unknown'
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractPriceFromHtml, extractPriceWithShipping } from '../../../src/lib/html-price';

describe('Amazon Shipping Price Extraction - Phase 3', () => {
  // Load HTML fixtures
  const fixturesDir = path.join(__dirname, '../../fixtures');
  const freeShippingHtml = fs.readFileSync(
    path.join(fixturesDir, 'amazon-free-shipping.html'),
    'utf-8'
  );
  const paidShippingHtml = fs.readFileSync(
    path.join(fixturesDir, 'amazon-paid-shipping.html'),
    'utf-8'
  );
  const unknownShippingHtml = fs.readFileSync(
    path.join(fixturesDir, 'amazon-unknown-shipping.html'),
    'utf-8'
  );

  describe('extractPriceWithShipping - Enhanced Function', () => {
    describe('FREE shipping scenario', () => {
      it('should extract item price and FREE shipping', () => {
        const result = extractPriceWithShipping(freeShippingHtml);

        expect(result.amazonItemPrice).toBe(16.99);
        expect(result.amazonShippingPrice).toBe(0);
        expect(result.shippingEvidence).toBe('free');
      });

      it('should return all required fields', () => {
        const result = extractPriceWithShipping(freeShippingHtml);

        expect(result).toHaveProperty('amazonItemPrice');
        expect(result).toHaveProperty('amazonShippingPrice');
        expect(result).toHaveProperty('shippingEvidence');
      });

      it('should identify explicit FREE shipping text', () => {
        const result = extractPriceWithShipping(freeShippingHtml);

        // Shipping should be exactly 0, not null or undefined
        expect(result.amazonShippingPrice).toBe(0);
        expect(result.amazonShippingPrice).not.toBeNull();
        expect(result.amazonShippingPrice).not.toBeUndefined();
        
        // Evidence should be 'free'
        expect(result.shippingEvidence).toBe('free');
      });
    });

    describe('PAID shipping scenario', () => {
      it('should extract item price and paid shipping', () => {
        const result = extractPriceWithShipping(paidShippingHtml);

        expect(result.amazonItemPrice).toBe(32.50);
        expect(result.amazonShippingPrice).toBe(6.99);
        expect(result.shippingEvidence).toBe('paid');
      });

      it('should parse shipping cost from text', () => {
        const result = extractPriceWithShipping(paidShippingHtml);

        // Shipping should be parsed correctly
        expect(result.amazonShippingPrice).toBeGreaterThan(0);
        expect(result.amazonShippingPrice).toBe(6.99);
        
        // Evidence should be 'paid'
        expect(result.shippingEvidence).toBe('paid');
      });

      it('should handle shipping with import fees text', () => {
        const result = extractPriceWithShipping(paidShippingHtml);

        // HTML contains "+ $6.99 Shipping & Import Fees Deposit"
        expect(result.amazonShippingPrice).toBe(6.99);
        expect(result.shippingEvidence).toBe('paid');
      });
    });

    describe('UNKNOWN shipping scenario', () => {
      it('should default to 0 with unknown evidence', () => {
        const result = extractPriceWithShipping(unknownShippingHtml);

        expect(result.amazonItemPrice).toBe(19.99);
        expect(result.amazonShippingPrice).toBe(0);
        expect(result.shippingEvidence).toBe('unknown');
      });

      it('should not confuse unknown with free shipping', () => {
        const result = extractPriceWithShipping(unknownShippingHtml);

        // Both have shipping=0, but evidence differs
        expect(result.amazonShippingPrice).toBe(0);
        expect(result.shippingEvidence).toBe('unknown'); // NOT 'free'
      });

      it('should allow caller to handle unknown shipping appropriately', () => {
        const result = extractPriceWithShipping(unknownShippingHtml);

        // Caller can check evidence and decide how to proceed
        if (result.shippingEvidence === 'unknown') {
          // Could choose to skip this product, estimate shipping, etc.
          expect(result.amazonShippingPrice).toBe(0);
        }
      });
    });

    describe('Shipping evidence types', () => {
      it('should return one of three evidence values', () => {
        const freeResult = extractPriceWithShipping(freeShippingHtml);
        const paidResult = extractPriceWithShipping(paidShippingHtml);
        const unknownResult = extractPriceWithShipping(unknownShippingHtml);

        const validEvidence = ['free', 'paid', 'unknown'];
        
        expect(validEvidence).toContain(freeResult.shippingEvidence);
        expect(validEvidence).toContain(paidResult.shippingEvidence);
        expect(validEvidence).toContain(unknownResult.shippingEvidence);
      });

      it('should use free evidence for FREE shipping', () => {
        const result = extractPriceWithShipping(freeShippingHtml);
        expect(result.shippingEvidence).toBe('free');
      });

      it('should use paid evidence for paid shipping', () => {
        const result = extractPriceWithShipping(paidShippingHtml);
        expect(result.shippingEvidence).toBe('paid');
      });

      it('should use unknown evidence when cannot determine', () => {
        const result = extractPriceWithShipping(unknownShippingHtml);
        expect(result.shippingEvidence).toBe('unknown');
      });
    });

    describe('Price extraction integrity', () => {
      it('should extract same item price as legacy function', () => {
        const enhanced = extractPriceWithShipping(freeShippingHtml);
        const legacy = extractPriceFromHtml(freeShippingHtml);

        expect(enhanced.amazonItemPrice).toBe(legacy);
        expect(enhanced.amazonItemPrice).toBe(16.99);
      });

      it('should maintain price accuracy with shipping data', () => {
        const result = extractPriceWithShipping(paidShippingHtml);

        // Item price should be unaffected by shipping extraction
        expect(result.amazonItemPrice).toBe(32.50);
        
        // Both item and shipping should be present
        expect(result.amazonShippingPrice).toBe(6.99);
        
        // Can calculate total: 32.50 + 6.99 = 39.49
        const total = result.amazonItemPrice! + result.amazonShippingPrice;
        expect(total).toBe(39.49);
      });
    });
  });

  describe('extractPriceFromHtml - Backward Compatibility', () => {
    it('should still return number | null (legacy behavior)', () => {
      const price = extractPriceFromHtml(freeShippingHtml);

      expect(typeof price).toBe('number');
      expect(price).toBe(16.99);
    });

    it('should work with free shipping fixture', () => {
      const price = extractPriceFromHtml(freeShippingHtml);
      expect(price).toBe(16.99);
    });

    it('should work with paid shipping fixture', () => {
      const price = extractPriceFromHtml(paidShippingHtml);
      expect(price).toBe(32.50);
    });

    it('should work with unknown shipping fixture', () => {
      const price = extractPriceFromHtml(unknownShippingHtml);
      expect(price).toBe(19.99);
    });

    it('should not expose shipping information (legacy)', () => {
      const price = extractPriceFromHtml(paidShippingHtml);

      // Legacy function returns only the number, no shipping data
      expect(price).toBe(32.50);
      expect(typeof price).toBe('number');
    });

    it('should return null when no price found', () => {
      const emptyHtml = '<html><body>No price here</body></html>';
      const price = extractPriceFromHtml(emptyHtml);

      expect(price).toBeNull();
    });
  });

  describe('Real-world shipping patterns', () => {
    it('should handle "FREE Delivery" text variation', () => {
      const html = `
        <html><body>
          <span class="a-price-whole">25</span>
          <span class="a-price-fraction">99</span>
          <div>FREE Delivery on orders over $35</div>
        </body></html>
      `;

      const result = extractPriceWithShipping(html);
      
      expect(result.amazonShippingPrice).toBe(0);
      expect(result.shippingEvidence).toBe('free');
    });

    it('should handle "Shipping: $X.XX" format', () => {
      const html = `
        <html><body>
          <span class="a-price-whole">45</span>
          <span class="a-price-fraction">00</span>
          <div>Shipping: $12.50</div>
        </body></html>
      `;

      const result = extractPriceWithShipping(html);
      
      expect(result.amazonShippingPrice).toBe(12.50);
      expect(result.shippingEvidence).toBe('paid');
    });

    it('should handle shipping with decimals', () => {
      const html = `
        <html><body>
          <span class="a-price-whole">20</span>
          <span class="a-price-fraction">00</span>
          <div>+ $8.47 shipping</div>
        </body></html>
      `;

      const result = extractPriceWithShipping(html);
      
      expect(result.amazonShippingPrice).toBe(8.47);
      expect(result.shippingEvidence).toBe('paid');
    });

    it('should handle whole dollar shipping', () => {
      const html = `
        <html><body>
          <span class="a-price-whole">30</span>
          <span class="a-price-fraction">00</span>
          <div>+ $5 shipping</div>
        </body></html>
      `;

      const result = extractPriceWithShipping(html);
      
      // Should parse "5" as 5.00
      expect(result.amazonShippingPrice).toBe(5);
      expect(result.shippingEvidence).toBe('paid');
    });
  });

  describe('No behavior change verification', () => {
    it('should not affect existing pricing logic', () => {
      // Phase 3 adds fields but doesn't change how prices are calculated
      const legacyPrice = extractPriceFromHtml(freeShippingHtml);
      const enhancedResult = extractPriceWithShipping(freeShippingHtml);

      // Item price should be identical
      expect(enhancedResult.amazonItemPrice).toBe(legacyPrice);
      expect(enhancedResult.amazonItemPrice).toBe(16.99);
    });

    it('should maintain backward compatibility with all callers', () => {
      // Existing code using extractPriceFromHtml should still work
      const fixtures = [freeShippingHtml, paidShippingHtml, unknownShippingHtml];
      
      fixtures.forEach(html => {
        const price = extractPriceFromHtml(html);
        
        // Should return number or null (legacy behavior)
        expect(price === null || typeof price === 'number').toBe(true);
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle empty HTML', () => {
      const result = extractPriceWithShipping('');
      
      expect(result.amazonItemPrice).toBeNull();
      expect(result.amazonShippingPrice).toBe(0);
      expect(result.shippingEvidence).toBe('unknown');
    });

    it('should handle malformed HTML', () => {
      const result = extractPriceWithShipping('<html><body>broken');
      
      expect(result.amazonItemPrice).toBeNull();
      expect(result.amazonShippingPrice).toBe(0);
      expect(result.shippingEvidence).toBe('unknown');
    });

    it('should handle multiple shipping messages (prefer first match)', () => {
      const html = `
        <html><body>
          <span class="a-price-whole">40</span>
          <span class="a-price-fraction">00</span>
          <div>FREE Shipping</div>
          <div>+ $10 shipping</div>
        </body></html>
      `;

      const result = extractPriceWithShipping(html);
      
      // Should find FREE first and stop
      expect(result.amazonShippingPrice).toBe(0);
      expect(result.shippingEvidence).toBe('free');
    });
  });
});
