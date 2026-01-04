/**
 * Tests for computeEbayOfferPricingCents - Step 2 of DraftPilot pricing fix
 * 
 * Coverage:
 * - FREE_SHIPPING: item == targetDelivered, shippingCharge == 0
 * - BUYER_PAYS_SHIPPING: item + shippingCharge == targetDelivered
 * - Low-price with autoFreeShipping ON: switches to free shipping, warning present
 * - Low-price with autoFreeShipping OFF: clamps to minItem, warns cannotCompete
 * - No negative values ever
 * - Invariant: itemPriceCents + shippingChargeCents === targetDeliveredTotalCents
 */

import { 
  computeEbayOfferPricingCents, 
  formatPricingLogLine,
  type EbayOfferPricingResult 
} from '../../src/lib/pricing-compute.js';
import { getDefaultPricingSettings, type PricingSettings } from '../../src/lib/pricing-config.js';

describe('computeEbayOfferPricingCents', () => {
  // Helper to create settings with overrides
  const makeSettings = (overrides: Partial<PricingSettings> = {}): PricingSettings => ({
    ...getDefaultPricingSettings(),
    ...overrides,
  });

  describe('FREE_SHIPPING mode', () => {
    it('should set item = targetDelivered and shippingCharge = 0', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 2500, // $25.00 target
        shippingCostEstimateCents: 600, // We pay $6 to carrier
        settings: makeSettings({ ebayShippingMode: 'FREE_SHIPPING' }),
      });

      expect(result.itemPriceCents).toBe(2500);
      expect(result.shippingChargeCents).toBe(0);
      expect(result.targetDeliveredTotalCents).toBe(2500);
      expect(result.effectiveShippingMode).toBe('FREE_SHIPPING');
      expect(result.warnings).toHaveLength(0);
    });

    it('should preserve shippingCostEstimateCents separately', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 2500,
        shippingCostEstimateCents: 750, // $7.50 we pay to carrier
        settings: makeSettings({ ebayShippingMode: 'FREE_SHIPPING' }),
      });

      // shippingCostEstimate is what WE pay, not what buyer pays
      expect(result.shippingCostEstimateCents).toBe(750);
      expect(result.shippingChargeCents).toBe(0); // Buyer pays $0 shipping
    });

    it('should satisfy invariant: item + shippingCharge == targetDelivered', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 3499,
        shippingCostEstimateCents: 600,
        settings: makeSettings({ ebayShippingMode: 'FREE_SHIPPING' }),
      });

      expect(result.itemPriceCents + result.shippingChargeCents)
        .toBe(result.targetDeliveredTotalCents);
    });
  });

  describe('BUYER_PAYS_SHIPPING mode', () => {
    it('should split: item + shippingCharge = targetDelivered', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 2500, // $25.00 target
        shippingCostEstimateCents: 600,
        settings: makeSettings({ 
          ebayShippingMode: 'BUYER_PAYS_SHIPPING',
          buyerShippingChargeCents: 600, // Buyer pays $6 shipping
        }),
      });

      expect(result.itemPriceCents).toBe(1900); // $25 - $6 = $19
      expect(result.shippingChargeCents).toBe(600);
      expect(result.targetDeliveredTotalCents).toBe(2500);
      expect(result.effectiveShippingMode).toBe('BUYER_PAYS_SHIPPING');
    });

    it('should satisfy invariant: item + shippingCharge == targetDelivered', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 2874, // $28.74 target
        shippingCostEstimateCents: 710,
        settings: makeSettings({ 
          ebayShippingMode: 'BUYER_PAYS_SHIPPING',
          buyerShippingChargeCents: 600,
        }),
      });

      expect(result.itemPriceCents + result.shippingChargeCents)
        .toBe(result.targetDeliveredTotalCents);
      expect(result.itemPriceCents).toBe(2274); // $28.74 - $6 = $22.74
      expect(result.shippingChargeCents).toBe(600);
    });

    it('should use different buyerShippingChargeCents values', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 3000,
        shippingCostEstimateCents: 600,
        settings: makeSettings({ 
          ebayShippingMode: 'BUYER_PAYS_SHIPPING',
          buyerShippingChargeCents: 800, // Buyer pays $8 shipping
        }),
      });

      expect(result.itemPriceCents).toBe(2200); // $30 - $8 = $22
      expect(result.shippingChargeCents).toBe(800);
    });
  });

  describe('Low price with autoFreeShipping ON', () => {
    it('should auto-switch to FREE_SHIPPING when item would be below floor', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 500, // $5.00 target
        shippingCostEstimateCents: 600,
        settings: makeSettings({ 
          ebayShippingMode: 'BUYER_PAYS_SHIPPING',
          buyerShippingChargeCents: 600, // Would make item = $5 - $6 = -$1
          minItemPriceCents: 199,
          allowAutoFreeShippingOnLowPrice: true,
        }),
      });

      expect(result.effectiveShippingMode).toBe('FREE_SHIPPING');
      expect(result.shippingChargeCents).toBe(0);
      expect(result.itemPriceCents).toBe(500); // Full target as item price
      expect(result.warnings).toContain('autoSwitchedToFreeShipping');
    });

    it('should still clamp if even free shipping is below floor', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 100, // $1.00 target (below $1.99 floor)
        shippingCostEstimateCents: 600,
        settings: makeSettings({ 
          ebayShippingMode: 'BUYER_PAYS_SHIPPING',
          buyerShippingChargeCents: 600,
          minItemPriceCents: 199,
          allowAutoFreeShippingOnLowPrice: true,
        }),
      });

      expect(result.effectiveShippingMode).toBe('FREE_SHIPPING');
      expect(result.itemPriceCents).toBe(199); // Clamped to floor
      expect(result.warnings).toContain('autoSwitchedToFreeShipping');
      expect(result.warnings).toContain('minItemFloorHit');
    });
  });

  describe('Low price with autoFreeShipping OFF', () => {
    it('should clamp to minItemPrice and warn cannotCompete', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 500, // $5.00 target
        shippingCostEstimateCents: 600,
        settings: makeSettings({ 
          ebayShippingMode: 'BUYER_PAYS_SHIPPING',
          buyerShippingChargeCents: 600, // Would make item = -$1
          minItemPriceCents: 199,
          allowAutoFreeShippingOnLowPrice: false, // Don't auto-switch
        }),
      });

      expect(result.effectiveShippingMode).toBe('BUYER_PAYS_SHIPPING');
      expect(result.itemPriceCents).toBe(199); // Clamped to floor
      expect(result.shippingChargeCents).toBe(600); // Still charging shipping
      expect(result.warnings).toContain('minItemFloorHit');
      expect(result.warnings).toContain('cannotCompete');
    });

    it('should result in delivered == item+shipping when clamped (invariant maintained)', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 500, // $5.00 target
        shippingCostEstimateCents: 600,
        settings: makeSettings({ 
          ebayShippingMode: 'BUYER_PAYS_SHIPPING',
          buyerShippingChargeCents: 600,
          minItemPriceCents: 199,
          allowAutoFreeShippingOnLowPrice: false,
        }),
      });

      // Buyer pays $1.99 + $6 = $7.99, targetDelivered is updated to match
      const buyerTotal = result.itemPriceCents + result.shippingChargeCents;
      expect(buyerTotal).toBe(799);
      // Invariant: targetDeliveredTotalCents === item + shipping
      expect(result.targetDeliveredTotalCents).toBe(buyerTotal);
    });
  });

  describe('No negative values', () => {
    it('should never return negative itemPriceCents', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 0,
        shippingCostEstimateCents: 600,
        settings: makeSettings({ 
          ebayShippingMode: 'FREE_SHIPPING',
          minItemPriceCents: 0, // Allow $0 floor for this test
        }),
      });

      expect(result.itemPriceCents).toBeGreaterThanOrEqual(0);
    });

    it('should never return negative shippingChargeCents', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 100,
        shippingCostEstimateCents: 600,
        settings: makeSettings({ 
          ebayShippingMode: 'BUYER_PAYS_SHIPPING',
          buyerShippingChargeCents: 0, // No shipping charge
        }),
      });

      expect(result.shippingChargeCents).toBeGreaterThanOrEqual(0);
    });

    it('should clamp negative calculations to 0', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 100, // $1.00 target
        shippingCostEstimateCents: 600,
        settings: makeSettings({ 
          ebayShippingMode: 'BUYER_PAYS_SHIPPING',
          buyerShippingChargeCents: 600, // Would make item = $1 - $6 = -$5
          minItemPriceCents: 0, // Allow $0 floor
          allowAutoFreeShippingOnLowPrice: false,
        }),
      });

      expect(result.itemPriceCents).toBe(0); // Clamped to 0
      expect(result.shippingChargeCents).toBe(600);
    });
  });

  describe('Evidence logging', () => {
    it('should include all required evidence fields', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 2500,
        shippingCostEstimateCents: 600,
        settings: makeSettings({ ebayShippingMode: 'FREE_SHIPPING' }),
      });

      expect(result.evidence).toMatchObject({
        baseDeliveredTargetCents: 2500,
        shippingCostEstimateCents: 600,
        requestedShippingMode: 'FREE_SHIPPING',
        effectiveShippingMode: 'FREE_SHIPPING',
        itemPriceCents: 2500,
        targetDeliveredTotalCents: 2500,
      });
    });

    it('should track autoFreeShippingTriggered', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 500,
        shippingCostEstimateCents: 600,
        settings: makeSettings({ 
          ebayShippingMode: 'BUYER_PAYS_SHIPPING',
          buyerShippingChargeCents: 600,
          minItemPriceCents: 199,
          allowAutoFreeShippingOnLowPrice: true,
        }),
      });

      expect(result.evidence.autoFreeShippingTriggered).toBe(true);
      expect(result.evidence.requestedShippingMode).toBe('BUYER_PAYS_SHIPPING');
      expect(result.evidence.effectiveShippingMode).toBe('FREE_SHIPPING');
    });
  });

  describe('formatPricingLogLine', () => {
    it('should format FREE_SHIPPING result correctly', () => {
      const result: EbayOfferPricingResult = {
        targetDeliveredTotalCents: 2500,
        itemPriceCents: 2500,
        shippingChargeCents: 0,
        shippingCostEstimateCents: 600,
        effectiveShippingMode: 'FREE_SHIPPING',
        warnings: [],
        evidence: {} as any,
      };

      const logLine = formatPricingLogLine(result);
      
      expect(logLine).toContain('deliveredTarget=$25.00');
      expect(logLine).toContain('mode=FREE');
      expect(logLine).toContain('shippingCharge=$0.00');
      expect(logLine).toContain('item=$25.00');
      expect(logLine).toContain('shipCostEst=$6.00');
      expect(logLine).toContain('warnings=[none]');
    });

    it('should format BUYER_PAYS_SHIPPING result correctly', () => {
      const result: EbayOfferPricingResult = {
        targetDeliveredTotalCents: 2500,
        itemPriceCents: 1900,
        shippingChargeCents: 600,
        shippingCostEstimateCents: 600,
        effectiveShippingMode: 'BUYER_PAYS_SHIPPING',
        warnings: ['minItemFloorHit'],
        evidence: {} as any,
      };

      const logLine = formatPricingLogLine(result);
      
      expect(logLine).toContain('mode=BUYER_PAYS');
      expect(logLine).toContain('shippingCharge=$6.00');
      expect(logLine).toContain('item=$19.00');
      expect(logLine).toContain('warnings=[minItemFloorHit]');
    });
  });

  // ============================================================================
  // User-Specified Acceptance Scenarios (6 exact scenarios that must pass)
  // ============================================================================
  describe('User Acceptance Scenarios', () => {
    // Scenario 1: FREE_SHIPPING normal
    // baseDeliveredTargetCents = 5130 ($51.30)
    // Expected: itemPriceCents = 5130, shippingChargeCents = 0
    it('Scenario 1: FREE_SHIPPING normal - $51.30 delivered', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 5130,
        shippingCostEstimateCents: 600,
        settings: makeSettings({
          ebayShippingMode: 'FREE_SHIPPING',
          buyerShippingChargeCents: 600,
          minItemPriceCents: 499,
          allowAutoFreeShippingOnLowPrice: true,
        }),
      });

      expect(result.itemPriceCents).toBe(5130);
      expect(result.shippingChargeCents).toBe(0);
      expect(result.targetDeliveredTotalCents).toBe(5130);
      expect(result.effectiveShippingMode).toBe('FREE_SHIPPING');
      expect(result.warnings).toEqual([]);
      // Invariant check
      expect(result.itemPriceCents + result.shippingChargeCents).toBe(result.targetDeliveredTotalCents);
    });

    // Scenario 2: BUYER_PAYS_SHIPPING normal
    // baseDeliveredTargetCents = 5130 ($51.30)
    // Expected: itemPriceCents = 4530, shippingChargeCents = 600
    it('Scenario 2: BUYER_PAYS_SHIPPING normal - $51.30 delivered → $45.30 + $6.00', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 5130,
        shippingCostEstimateCents: 600,
        settings: makeSettings({
          ebayShippingMode: 'BUYER_PAYS_SHIPPING',
          buyerShippingChargeCents: 600,
          minItemPriceCents: 499,
          allowAutoFreeShippingOnLowPrice: true,
        }),
      });

      expect(result.itemPriceCents).toBe(4530);
      expect(result.shippingChargeCents).toBe(600);
      expect(result.targetDeliveredTotalCents).toBe(5130);
      expect(result.effectiveShippingMode).toBe('BUYER_PAYS_SHIPPING');
      expect(result.warnings).toEqual([]);
      // Invariant check
      expect(result.itemPriceCents + result.shippingChargeCents).toBe(result.targetDeliveredTotalCents);
    });

    // Scenario 3: Low-price with autoFreeShipping ON
    // baseDeliveredTargetCents = 489 ($4.89), minItemPriceCents = 499 ($4.99)
    // BUYER_PAYS would give item = 489 - 600 = negative, so auto-switch to FREE
    // Expected: switch to FREE_SHIPPING, itemPriceCents = 499, shippingChargeCents = 0
    it('Scenario 3: Low-price with autoFreeShipping ON - $4.89 → switch to FREE, floor to $4.99', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 489,
        shippingCostEstimateCents: 600,
        settings: makeSettings({
          ebayShippingMode: 'BUYER_PAYS_SHIPPING',
          buyerShippingChargeCents: 600,
          minItemPriceCents: 499,
          allowAutoFreeShippingOnLowPrice: true,
        }),
      });

      expect(result.effectiveShippingMode).toBe('FREE_SHIPPING');
      expect(result.itemPriceCents).toBe(499);
      expect(result.shippingChargeCents).toBe(0);
      expect(result.targetDeliveredTotalCents).toBe(499);
      expect(result.warnings).toContain('autoSwitchedToFreeShipping');
      expect(result.warnings).toContain('minItemFloorHit');
      // Invariant check
      expect(result.itemPriceCents + result.shippingChargeCents).toBe(result.targetDeliveredTotalCents);
    });

    // Scenario 4: Low-price with autoFreeShipping OFF
    // baseDeliveredTargetCents = 489 ($4.89), minItemPriceCents = 499 ($4.99)
    // BUYER_PAYS would give item = 489 - 600 = negative, but no auto-switch allowed
    // Expected: clamp to min, cannotCompete warning
    it('Scenario 4: Low-price with autoFreeShipping OFF - clamped, cannotCompete', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 489,
        shippingCostEstimateCents: 600,
        settings: makeSettings({
          ebayShippingMode: 'BUYER_PAYS_SHIPPING',
          buyerShippingChargeCents: 600,
          minItemPriceCents: 499,
          allowAutoFreeShippingOnLowPrice: false,
        }),
      });

      // Stays in BUYER_PAYS_SHIPPING but item is floored
      expect(result.effectiveShippingMode).toBe('BUYER_PAYS_SHIPPING');
      expect(result.itemPriceCents).toBe(499);
      expect(result.shippingChargeCents).toBe(600);
      // Total becomes 499 + 600 = 1099
      expect(result.targetDeliveredTotalCents).toBe(1099);
      expect(result.warnings).toContain('minItemFloorHit');
      expect(result.warnings).toContain('cannotCompete');
      // Invariant check
      expect(result.itemPriceCents + result.shippingChargeCents).toBe(result.targetDeliveredTotalCents);
    });

    // Scenario 5: Non-round numbers
    // baseDeliveredTargetCents = 5679 ($56.79)
    // Expected: itemPriceCents = 5079, shippingChargeCents = 600
    it('Scenario 5: Non-round numbers - $56.79 → $50.79 + $6.00', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 5679,
        shippingCostEstimateCents: 600,
        settings: makeSettings({
          ebayShippingMode: 'BUYER_PAYS_SHIPPING',
          buyerShippingChargeCents: 600,
          minItemPriceCents: 499,
          allowAutoFreeShippingOnLowPrice: true,
        }),
      });

      expect(result.itemPriceCents).toBe(5079);
      expect(result.shippingChargeCents).toBe(600);
      expect(result.targetDeliveredTotalCents).toBe(5679);
      expect(result.effectiveShippingMode).toBe('BUYER_PAYS_SHIPPING');
      expect(result.warnings).toEqual([]);
      // Invariant check
      expect(result.itemPriceCents + result.shippingChargeCents).toBe(result.targetDeliveredTotalCents);
    });

    // Scenario 6: "No double shipping" regression check
    // baseDeliveredTargetCents = 3474 ($34.74) - this is ALREADY a delivered total
    // Expected: itemPriceCents = 2874, shippingChargeCents = 600
    // MUST NOT become $34.74 + $6.00 = $40.74 (that would be double-counting)
    it('Scenario 6: No double shipping - $34.74 delivered must NOT become $40.74', () => {
      const result = computeEbayOfferPricingCents({
        baseDeliveredTargetCents: 3474, // This IS the delivered total, not an item price
        shippingCostEstimateCents: 600,
        settings: makeSettings({
          ebayShippingMode: 'BUYER_PAYS_SHIPPING',
          buyerShippingChargeCents: 600,
          minItemPriceCents: 499,
          allowAutoFreeShippingOnLowPrice: true,
        }),
      });

      // Key assertion: delivered total stays at 3474, NOT 3474 + 600
      expect(result.targetDeliveredTotalCents).toBe(3474);
      expect(result.itemPriceCents).toBe(2874);
      expect(result.shippingChargeCents).toBe(600);
      expect(result.effectiveShippingMode).toBe('BUYER_PAYS_SHIPPING');
      // Invariant check - this is the critical double-counting prevention
      expect(result.itemPriceCents + result.shippingChargeCents).toBe(result.targetDeliveredTotalCents);
      // Explicitly verify we didn't add shipping to the delivered total
      expect(result.targetDeliveredTotalCents).not.toBe(3474 + 600);
    });
  });
});
