/**
 * Tests for pricing settings persistence via user-settings-save/get functions
 * Validates UI → backend → storage → UI round-trip behavior
 */

import { handler as saveHandler } from '../../netlify/functions/user-settings-save.js';
import { handler as getHandler } from '../../netlify/functions/user-settings-get.js';
import type { HandlerEvent } from '@netlify/functions';

// Mock dependencies
jest.mock('../../src/lib/redis-store.js', () => ({
  tokensStore: jest.fn(),
}));

jest.mock('../../src/lib/_auth.js', () => ({
  getBearerToken: jest.fn(),
  getJwtSubUnverified: jest.fn(),
  requireAuthVerified: jest.fn(),
  userScopedKey: jest.fn((sub: string, file: string) => `users/${sub}/${file}`),
}));

describe('User Settings Persistence', () => {
  let mockStore: any;
  let mockGet: jest.Mock;
  let mockSet: jest.Mock;
  let mockGetBearerToken: jest.Mock;
  let mockGetJwtSubUnverified: jest.Mock;
  let mockRequireAuthVerified: jest.Mock;
  let mockUserScopedKey: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup mock store
    mockGet = jest.fn();
    mockSet = jest.fn();
    mockStore = { get: mockGet, set: mockSet };
    
    const { tokensStore } = require('../../src/lib/redis-store.js');
    tokensStore.mockReturnValue(mockStore);
    
    const auth = require('../../src/lib/_auth.js');
    mockGetBearerToken = auth.getBearerToken;
    mockGetJwtSubUnverified = auth.getJwtSubUnverified;
    mockRequireAuthVerified = auth.requireAuthVerified;
    mockUserScopedKey = auth.userScopedKey;
    
    mockGetBearerToken.mockReturnValue('mock-token');
    mockGetJwtSubUnverified.mockReturnValue('user-123');
    mockRequireAuthVerified.mockResolvedValue({ sub: 'user-123' });
    mockUserScopedKey.mockImplementation((sub: string, file: string) => `users/${sub}/${file}`);
  });

  describe('Saving Pricing Settings', () => {
    it('1) saves pricing settings with expected values in storage blob', async () => {
      mockGet.mockResolvedValue(null); // No existing settings
      
      const event: Partial<HandlerEvent> = {
        body: JSON.stringify({
          pricing: {
            discountPercent: 15,
            shippingStrategy: 'DISCOUNT_ITEM_ONLY',
            templateShippingEstimateCents: 800,
            shippingSubsidyCapCents: 1000,
            minItemPriceCents: 299,
          }
        }),
        headers: {},
      };
      
      const result = await saveHandler(event as HandlerEvent, {} as any);
      	if (!result) throw new Error('No response');
      	const typedResult = result as import('@netlify/functions').HandlerResponse;

      expect(typedResult.statusCode).toBe(200);
      expect(mockSet).toHaveBeenCalledWith(
        'users/user-123/settings.json',
        expect.stringContaining('"pricing"')
      );
      
      const savedData = JSON.parse(mockSet.mock.calls[0][1]);
      expect(savedData.pricing).toEqual({
        discountPercent: 15,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 800,
        shippingSubsidyCapCents: 1000,
        minItemPriceCents: 299,
      });
    });

    it('2) merges partial pricing settings with existing data', async () => {
      mockGet.mockResolvedValue({
        autoPromoteEnabled: true,
        defaultPromotionRate: 8,
        pricing: {
          discountPercent: 10,
          shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
          templateShippingEstimateCents: 600,
          shippingSubsidyCapCents: null,
          minItemPriceCents: 199,
        }
      });
      
      const event: Partial<HandlerEvent> = {
        body: JSON.stringify({
          pricing: {
            discountPercent: 20, // Update only discount
          }
        }),
        headers: {},
      };
      
      const result = await saveHandler(event as HandlerEvent, {} as any);
      	if (!result) throw new Error('No response');
      	const typedResult = result as import('@netlify/functions').HandlerResponse;

      expect(typedResult.statusCode).toBe(200);
      const savedData = JSON.parse(mockSet.mock.calls[0][1]);
      
      // Promotion settings preserved
      expect(savedData.autoPromoteEnabled).toBe(true);
      expect(savedData.defaultPromotionRate).toBe(8);
      
      // Pricing partially updated
      expect(savedData.pricing.discountPercent).toBe(20); // UPDATED
      expect(savedData.pricing.shippingStrategy).toBe('ALGO_COMPETITIVE_TOTAL'); // PRESERVED
      expect(savedData.pricing.templateShippingEstimateCents).toBe(600); // PRESERVED
    });

    it('3) converts UI dollar inputs to cents correctly', async () => {
      mockGet.mockResolvedValue(null);
      
      // Simulate UI sending dollar values converted to cents
      const event: Partial<HandlerEvent> = {
        body: JSON.stringify({
          pricing: {
            templateShippingEstimateCents: 600, // $6.00 → 600 cents
            shippingSubsidyCapCents: 750,       // $7.50 → 750 cents
            minItemPriceCents: 199,             // $1.99 → 199 cents
          }
        }),
        headers: {},
      };
      
      const result = await saveHandler(event as HandlerEvent, {} as any);
      	if (!result) throw new Error('No response');
      	const typedResult = result as import('@netlify/functions').HandlerResponse;

      expect(typedResult.statusCode).toBe(200);
      const savedData = JSON.parse(mockSet.mock.calls[0][1]);
      
      expect(savedData.pricing.templateShippingEstimateCents).toBe(600);
      expect(savedData.pricing.shippingSubsidyCapCents).toBe(750);
      expect(savedData.pricing.minItemPriceCents).toBe(199);
    });

    it('4) saves blank shipping subsidy cap as null', async () => {
      mockGet.mockResolvedValue(null);
      
      const event: Partial<HandlerEvent> = {
        body: JSON.stringify({
          pricing: {
            shippingSubsidyCapCents: null, // Blank in UI → null in storage
          }
        }),
        headers: {},
      };
      
      const result = await saveHandler(event as HandlerEvent, {} as any);
      	if (!result) throw new Error('No response');
      	const typedResult = result as import('@netlify/functions').HandlerResponse;

      expect(typedResult.statusCode).toBe(200);
      const savedData = JSON.parse(mockSet.mock.calls[0][1]);
      
      expect(savedData.pricing.shippingSubsidyCapCents).toBeNull();
    });

    it('5) validates discountPercent range (0-50)', async () => {
      mockGet.mockResolvedValue(null);
      
      const event: Partial<HandlerEvent> = {
        body: JSON.stringify({
          pricing: {
            discountPercent: 75, // Invalid: > 50
          }
        }),
        headers: {},
      };
      
      const result = await saveHandler(event as HandlerEvent, {} as any);
      	if (!result) throw new Error('No response');
      	const typedResult = result as import('@netlify/functions').HandlerResponse;

      expect(typedResult.statusCode).toBe(400);
      expect(typedResult.body).toContain('discountPercent must be between 0 and 50');
    });

    it('6) validates shippingStrategy enum values', async () => {
      mockGet.mockResolvedValue(null);
      
      const event: Partial<HandlerEvent> = {
        body: JSON.stringify({
          pricing: {
            shippingStrategy: 'INVALID_STRATEGY', // Not in enum
          }
        }),
        headers: {},
      };
      
      const result = await saveHandler(event as HandlerEvent, {} as any);
      	if (!result) throw new Error('No response');
      	const typedResult = result as import('@netlify/functions').HandlerResponse;

      expect(typedResult.statusCode).toBe(400);
      expect(typedResult.body).toContain('shippingStrategy must be one of');
    });

    it('7) validates non-negative values', async () => {
      mockGet.mockResolvedValue(null);
      
      const invalidCases = [
        { templateShippingEstimateCents: -100 },
        { shippingSubsidyCapCents: -50 },
        { minItemPriceCents: -10 },
      ];
      
      for (const invalidCase of invalidCases) {
        const event: Partial<HandlerEvent> = {
          body: JSON.stringify({ pricing: invalidCase }),
          headers: {},
        };
        
        const result = await saveHandler(event as HandlerEvent, {} as any);
        	if (!result) throw new Error('No response');
        	const typedResult = result as import('@netlify/functions').HandlerResponse;

        expect(typedResult.statusCode).toBe(400);
      }
    });
  });

  describe('Loading Pricing Settings', () => {
    it('1) loads saved pricing settings and returns them', async () => {
      mockGet.mockResolvedValue({
        pricing: {
          discountPercent: 15,
          shippingStrategy: 'DISCOUNT_ITEM_ONLY',
          templateShippingEstimateCents: 800,
          shippingSubsidyCapCents: 1000,
          minItemPriceCents: 299,
        }
      });
      
      const event: Partial<HandlerEvent> = {
        headers: {},
      };
      
      const result = await getHandler(event as HandlerEvent, {} as any);
      	if (!result) throw new Error('No response');
      	const typedResult = result as import('@netlify/functions').HandlerResponse;

      expect(typedResult.statusCode).toBe(200);
      const data = JSON.parse(result.body as string);
      
      expect(data.pricing).toEqual({
        discountPercent: 15,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 800,
        shippingSubsidyCapCents: 1000,
        minItemPriceCents: 299,
      });
    });

    it('2) returns defaults when no settings saved', async () => {
      mockGet.mockResolvedValue(null);
      
      const event: Partial<HandlerEvent> = {
        headers: {},
      };
      
      const result = await getHandler(event as HandlerEvent, {} as any);
      	if (!result) throw new Error('No response');
      	const typedResult = result as import('@netlify/functions').HandlerResponse;

      expect(typedResult.statusCode).toBe(200);
      const data = JSON.parse(result.body as string);
      
      // Should match defaults from getDefaultPricingSettings()
      expect(data.pricing.discountPercent).toBe(10);
      expect(data.pricing.shippingStrategy).toBe('ALGO_COMPETITIVE_TOTAL');
      expect(data.pricing.templateShippingEstimateCents).toBe(600);
      expect(data.pricing.shippingSubsidyCapCents).toBeNull();
      expect(data.pricing.minItemPriceCents).toBe(199);
    });

    it('3) merges saved values with defaults for partial settings', async () => {
      mockGet.mockResolvedValue({
        pricing: {
          discountPercent: 20, // Only discount is saved
        }
      });
      
      const event: Partial<HandlerEvent> = {
        headers: {},
      };
      
      const result = await getHandler(event as HandlerEvent, {} as any);
      	if (!result) throw new Error('No response');
      	const typedResult = result as import('@netlify/functions').HandlerResponse;

      expect(typedResult.statusCode).toBe(200);
      const data = JSON.parse(result.body as string);
      
      expect(data.pricing.discountPercent).toBe(20); // Saved value
      expect(data.pricing.shippingStrategy).toBe('ALGO_COMPETITIVE_TOTAL'); // Default
      expect(data.pricing.templateShippingEstimateCents).toBe(600); // Default
    });

    it('4) correctly converts cents to dollars for UI display', async () => {
      mockGet.mockResolvedValue({
        pricing: {
          templateShippingEstimateCents: 750,  // 750 cents = $7.50
          shippingSubsidyCapCents: 1250,       // 1250 cents = $12.50
          minItemPriceCents: 199,              // 199 cents = $1.99
        }
      });
      
      const event: Partial<HandlerEvent> = {
        headers: {},
      };
      
      const result = await getHandler(event as HandlerEvent, {} as any);
      	if (!result) throw new Error('No response');
      	const typedResult = result as import('@netlify/functions').HandlerResponse;

      expect(typedResult.statusCode).toBe(200);
      const data = JSON.parse(result.body as string);
      
      // UI should divide by 100 to show dollars
      expect(data.pricing.templateShippingEstimateCents / 100).toBe(7.50);
      expect(data.pricing.shippingSubsidyCapCents / 100).toBe(12.50);
      expect(data.pricing.minItemPriceCents / 100).toBe(1.99);
    });

    it('5) handles null shipping subsidy cap correctly', async () => {
      mockGet.mockResolvedValue({
        pricing: {
          shippingSubsidyCapCents: null,
        }
      });
      
      const event: Partial<HandlerEvent> = {
        headers: {},
      };
      
      const result = await getHandler(event as HandlerEvent, {} as any);
      	if (!result) throw new Error('No response');
      	const typedResult = result as import('@netlify/functions').HandlerResponse;

      expect(typedResult.statusCode).toBe(200);
      const data = JSON.parse(result.body as string);
      
      // Null should be preserved (UI shows blank input)
      expect(data.pricing.shippingSubsidyCapCents).toBeNull();
    });
  });

  describe('Round-Trip Persistence', () => {
    it('1) saves and loads pricing settings with exact values', async () => {
      mockGet.mockResolvedValue(null);
      
      const originalSettings = {
        discountPercent: 12,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL' as const,
        templateShippingEstimateCents: 650,
        shippingSubsidyCapCents: 900,
        minItemPriceCents: 250,
      };
      
      // Save
      const saveEvent: Partial<HandlerEvent> = {
        body: JSON.stringify({ pricing: originalSettings }),
        headers: {},
      };
      
      const saveResult = await saveHandler(saveEvent as HandlerEvent, {} as any);
      if (!saveResult) throw new Error('No response');
      const typedSaveResult = saveResult as import('@netlify/functions').HandlerResponse;
      expect(typedSaveResult.statusCode).toBe(200);
      
      // Simulate loading saved data
      const savedData = JSON.parse(mockSet.mock.calls[0][1]);
      mockGet.mockResolvedValue(savedData);
      
      // Load
      const loadEvent: Partial<HandlerEvent> = {
        headers: {},
      };
      
      const loadResult = await getHandler(loadEvent as HandlerEvent, {} as any);
      if (!loadResult) throw new Error('No response');
      const typedLoadResult = loadResult as import('@netlify/functions').HandlerResponse;
      expect(typedLoadResult.statusCode).toBe(200);
      
      const loadedData = JSON.parse(typedLoadResult.body!);
      expect(loadedData.pricing).toEqual(originalSettings);
    });

    it('2) handles UI workflow: dollars → cents → storage → cents → dollars', async () => {
      mockGet.mockResolvedValue(null);
      
      // UI: User enters $6.50 for shipping
      const uiDollars = 6.50;
      const uiCents = Math.round(uiDollars * 100); // 650
      
      // Save (UI sends cents)
      const saveEvent: Partial<HandlerEvent> = {
        body: JSON.stringify({
          pricing: {
            templateShippingEstimateCents: uiCents,
          }
        }),
        headers: {},
      };
      
      const saveResult = await saveHandler(saveEvent as HandlerEvent, {} as any);
      if (!saveResult) throw new Error('No response');
      const typedSaveResult = saveResult as import('@netlify/functions').HandlerResponse;
      expect(typedSaveResult.statusCode).toBe(200);
      
      // Storage has cents
      const savedData = JSON.parse(mockSet.mock.calls[0][1]);
      expect(savedData.pricing.templateShippingEstimateCents).toBe(650);
      
      // Load (returns cents)
      mockGet.mockResolvedValue(savedData);
      const loadEvent: Partial<HandlerEvent> = {
        headers: {},
      };
      
      const loadResult = await getHandler(loadEvent as HandlerEvent, {} as any);
      if (!loadResult) throw new Error('No response');
      const typedLoadResult = loadResult as import('@netlify/functions').HandlerResponse;
      const loadedData = JSON.parse(typedLoadResult.body!);
      
      // UI converts back to dollars
      const displayDollars = loadedData.pricing.templateShippingEstimateCents / 100;
      expect(displayDollars).toBe(6.50);
    });
  });
});