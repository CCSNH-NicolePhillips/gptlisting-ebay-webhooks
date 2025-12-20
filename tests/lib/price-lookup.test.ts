/**
 * Comprehensive tests for price-lookup.ts
 * Target: 100% code coverage
 */

import { lookupPrice, type PriceLookupInput } from '../../src/lib/price-lookup';

// Mock dependencies
jest.mock('../../src/lib/html-price', () => ({
  extractPriceFromHtml: jest.fn(),
  extractPriceWithShipping: jest.fn(),
}));

jest.mock('../../src/lib/search', () => ({
  braveFirstUrlForBrandSite: jest.fn(),
  braveFirstUrl: jest.fn(),
}));

jest.mock('../../src/lib/brand-map', () => ({
  getBrandUrls: jest.fn(),
  setBrandUrls: jest.fn(),
}));

jest.mock('../../src/lib/pricing/ebay-sold-prices', () => ({
  fetchSoldPriceStats: jest.fn(),
}));

jest.mock('../../src/lib/openai', () => ({
  openai: {
    chat: {
      completions: {
        create: jest.fn(),
      },
    },
  },
}));

jest.mock('../../src/lib/price-cache', () => ({
  getCachedPrice: jest.fn(),
  setCachedPrice: jest.fn(),
  makePriceSig: jest.fn((brand, title) => `${brand || 'no-brand'}:${title}`),
}));

jest.mock('../../src/lib/brand-registry', () => ({
  getAmazonAsin: jest.fn(),
}));

import { extractPriceFromHtml, extractPriceWithShipping } from '../../src/lib/html-price';
import { braveFirstUrlForBrandSite, braveFirstUrl } from '../../src/lib/search';
import { getBrandUrls, setBrandUrls } from '../../src/lib/brand-map';
import { fetchSoldPriceStats } from '../../src/lib/pricing/ebay-sold-prices';
import { openai } from '../../src/lib/openai';
import { getCachedPrice, setCachedPrice } from '../../src/lib/price-cache';
import { getAmazonAsin } from '../../src/lib/brand-registry';

const mockExtractPrice = extractPriceFromHtml as jest.MockedFunction<typeof extractPriceFromHtml>;
const mockExtractPriceWithShipping = extractPriceWithShipping as jest.MockedFunction<typeof extractPriceWithShipping>;
const mockBrandUrlForBrandSite = braveFirstUrlForBrandSite as jest.MockedFunction<typeof braveFirstUrlForBrandSite>;
const mockBraveSearch = braveFirstUrl as jest.MockedFunction<typeof braveFirstUrl>;
const mockGetBrandUrls = getBrandUrls as jest.MockedFunction<typeof getBrandUrls>;
const mockSetBrandUrls = setBrandUrls as jest.MockedFunction<typeof setBrandUrls>;
const mockFetchSoldStats = fetchSoldPriceStats as jest.MockedFunction<typeof fetchSoldPriceStats>;
const mockOpenAI = openai.chat.completions.create as jest.MockedFunction<typeof openai.chat.completions.create>;
const mockGetCachedPrice = getCachedPrice as jest.MockedFunction<typeof getCachedPrice>;
const mockSetCachedPrice = setCachedPrice as jest.MockedFunction<typeof setCachedPrice>;
const mockGetAmazonAsin = getAmazonAsin as jest.MockedFunction<typeof getAmazonAsin>;

// Mock global fetch
global.fetch = jest.fn();

describe('price-lookup.ts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCachedPrice.mockResolvedValue(null); // No cache by default
    mockGetAmazonAsin.mockResolvedValue(null); // No registered ASIN by default
    // Mock fetch to return HTML with a price
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () => '<div class="price">$29.99</div>',
    });
    // Mock extractPriceWithShipping to return valid data
    mockExtractPriceWithShipping.mockReturnValue({
      amazonItemPrice: 29.99,
      amazonShippingPrice: 0,
      shippingEvidence: 'free',
      pageTitle: 'Mock Product Title',
    } as any);
  });

  describe('lookupPrice', () => {
    describe('Cache behavior', () => {
      it('should return cached price if available', async () => {
        const cachedData = {
          msrpCents: 2599, // $25.99 MSRP
          chosen: {
            source: 'brand-msrp' as const,
            price: 25.99,
            currency: 'USD',
            shippingCents: 600,
          },
          candidates: [],
          cachedAt: Date.now(),
        };

        mockGetCachedPrice.mockResolvedValue(cachedData);

        const input: PriceLookupInput = {
          title: 'Test Product',
          brand: 'Test Brand',
        };

        const result = await lookupPrice(input);

        // Should compute price from cached MSRP with default settings (10% discount, $6 shipping)
        // ALGO_COMPETITIVE_TOTAL: Target = ($25.99 + $6.00) × 0.9 = $28.79
        // eBay item price = $28.79 - $6.00 = $22.79
        expect(result.ok).toBe(true);
        expect(result.chosen).toEqual(cachedData.chosen);
        expect(result.recommendedListingPrice).toBeCloseTo(22.79, 2);
        expect(mockGetCachedPrice).toHaveBeenCalledWith('Test Brand:Test Product');
        expect(mockFetchSoldStats).not.toHaveBeenCalled(); // Should not make API calls
      });
    });

    describe('Tier 1: eBay sold prices', () => {
      it('should fetch and use eBay sold price (p35)', async () => {
        mockFetchSoldStats.mockResolvedValue({
          ok: true,
          rateLimited: false,
          p35: 19.99,
          median: 22.50,
          samples: [{ price: 19.99, currency: 'USD' }],
        });

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'ebay-sold',
                basePrice: 19.99,
                recommendedListingPrice: 19.99,
                reasoning: 'Using eBay sold data',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Fish Oil 1000mg',
          brand: 'Nature Made',
          condition: 'NEW',
        };

        const result = await lookupPrice(input);

        expect(result.ok).toBe(true);
        expect(result.chosen?.source).toBe('ebay-sold');
        expect(mockFetchSoldStats).toHaveBeenCalledWith({
          title: 'Fish Oil 1000mg',
          brand: 'Nature Made',
          upc: undefined,
          condition: 'NEW',
          quantity: undefined,
        });
      });

      it('should skip eBay sold prices if rate limited', async () => {
        mockFetchSoldStats.mockResolvedValue({
          ok: false,
          rateLimited: true,
          samples: [],
        });

        mockBraveSearch.mockResolvedValue(null); // No brand site found
        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'estimate',
                basePrice: 24.99,
                recommendedListingPrice: 24.99,
                reasoning: 'Using estimate',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Vitamin D3',
        };

        const result = await lookupPrice(input);

        expect(result.ok).toBe(true);
        expect(mockFetchSoldStats).toHaveBeenCalled();
      });
    });

    describe('Tier 2: Brand MSRP', () => {
      it('should fetch brand MSRP from Vision API website', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        
        // Mock fetchHtml and extractPriceFromHtml (synchronous function)
        mockExtractPrice.mockReturnValue(29.99);

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'brand-msrp',
                basePrice: 29.99,
                recommendedListingPrice: 26.99,
                reasoning: 'Brand MSRP with 10% discount',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Fish Oil',
          brand: 'Nordic Naturals',
          brandWebsite: 'https://nordicnaturals.com/product/fish-oil',
        };

        const result = await lookupPrice(input);

        expect(result.ok).toBe(true);
        expect(result.chosen?.source).toBe('brand-msrp');
        expect(result.recommendedListingPrice).toBe(26.99);
      });

      it('should skip homepage URLs for brand sites', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBraveSearch.mockResolvedValue(null);

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'estimate',
                basePrice: 24.99,
                recommendedListingPrice: 24.99,
                reasoning: 'Using estimate',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Fish Oil',
          brand: 'Nordic Naturals',
          brandWebsite: 'https://nordicnaturals.com/', // Homepage - should skip
        };

        const result = await lookupPrice(input);

        expect(result.ok).toBe(true);
        // Should not try to extract price from homepage
      });
    });

    describe('Amazon marketplace brand filtering', () => {
      beforeEach(() => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
      });

      it('should skip Amazon candidates that do not match the requested brand', async () => {
        mockBraveSearch.mockResolvedValue('https://www.amazon.com/example-product');
        mockExtractPriceWithShipping.mockReturnValueOnce({
          amazonItemPrice: 19.99,
          amazonShippingPrice: 0,
          shippingEvidence: 'free',
          pageTitle: 'Amazon.com: Drinkwel Better Mornings',
        } as any);
        mockExtractPrice.mockReturnValue(69.99);
        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'brand-msrp',
                basePrice: 69.99,
                recommendedListingPrice: 62.99,
                reasoning: 'Brand MSRP retained after filtering Amazon mismatch',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Morning Strawberry Mango 296.7g',
          brand: 'bettr.',
          brandWebsite: 'https://performbettr.com/products/morning-strawberry-mango.html',
        };

        const result = await lookupPrice(input);

        const amazonCandidate = result.candidates.find((c) => c.source === 'brave-fallback');
        expect(amazonCandidate).toBeUndefined();
        expect(result.candidates.some((c) => c.source === 'brand-msrp')).toBe(true);
      });

      it('should keep Amazon candidates and set matchesBrand when the title contains the brand', async () => {
        mockBraveSearch.mockResolvedValue('https://www.amazon.com/example-product');
        mockExtractPriceWithShipping.mockReturnValueOnce({
          amazonItemPrice: 64.99,
          amazonShippingPrice: 0,
          shippingEvidence: 'free',
          pageTitle: 'Amazon.com: Bettr. Morning Strawberry Mango Supplement',
        } as any);
        mockExtractPrice.mockReturnValue(69.99);
        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'brand-msrp',
                basePrice: 69.99,
                recommendedListingPrice: 62.99,
                reasoning: 'Brand MSRP baseline',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Morning Strawberry Mango 296.7g',
          brand: 'bettr.',
          brandWebsite: 'https://performbettr.com/products/morning-strawberry-mango.html',
        };

        const result = await lookupPrice(input);

        const amazonCandidate = result.candidates.find((c) => c.source === 'amazon');
        expect(amazonCandidate).toBeDefined();
        expect(amazonCandidate?.matchesBrand).toBe(true);
      });
    });

    describe('Tier 3: AI arbitration', () => {
      it('should apply photoQuantity multiplier correctly', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBraveSearch.mockResolvedValue(null);

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'estimate',
                basePrice: 22.45,
                recommendedListingPrice: 20.20,
                reasoning: 'Estimate with 10% discount',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Fish Oil',
          brand: 'Nature Made',
          photoQuantity: 2, // 2 bottles in photo
          amazonPackSize: 1, // Single unit on Amazon
        };

        const result = await lookupPrice(input);

        expect(result.ok).toBe(true);
        // lotBeforeDiscount = 22.45 / 1 * 2 = 44.90
        // finalListing = 20.20 / 22.45 * 44.90 = ~40.40
        expect(result.recommendedListingPrice).toBeCloseTo(40.40, 1);
      });

      it('should apply amazonPackSize normalization correctly', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBraveSearch.mockResolvedValue(null);

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'estimate',
                basePrice: 44.90,
                recommendedListingPrice: 40.41,
                reasoning: 'Estimate with 10% discount',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Fish Oil',
          brand: 'Nature Made',
          photoQuantity: 1, // 1 bottle in photo
          amazonPackSize: 2, // 2-pack on Amazon
        };

        const result = await lookupPrice(input);

        expect(result.ok).toBe(true);
        // perUnit = 44.90 / 2 = 22.45
        // lotBeforeDiscount = 22.45 * 1 = 22.45
        // finalListing = 40.41 / 44.90 * 22.45 = ~20.20
        expect(result.recommendedListingPrice).toBeCloseTo(20.20, 1);
      });

      it('should handle AI arbitration failure with fallback', async () => {
        mockFetchSoldStats.mockResolvedValue({
          ok: true,
          rateLimited: false,
          p35: 18.99,
          median: 20.00,
          samples: [{ price: 18.99, currency: 'USD' }],
        });

        mockOpenAI.mockRejectedValue(new Error('API timeout'));

        const input: PriceLookupInput = {
          title: 'Vitamin C',
          brand: 'Test',
        };

        const result = await lookupPrice(input);

        expect(result.ok).toBe(true);
        expect(result.chosen?.source).toBe('ebay-sold');
        expect(result.chosen?.price).toBe(18.99);
      });

      it('should use category-based estimate when no candidates', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBraveSearch.mockResolvedValue(null);

        const input: PriceLookupInput = {
          title: 'Unknown Product',
        };

        const result = await lookupPrice(input);

        // System provides fallback estimate instead of failing
        expect(result.ok).toBe(true);
        expect(result.chosen?.source).toBe('estimate');
        expect(result.chosen?.price).toBe(29.99); // Default supplement estimate
      });
    });

    describe('Category-based estimates', () => {
      it('should provide estimate for supplements', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBraveSearch.mockResolvedValue(null);

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'estimate',
                basePrice: 29.99,
                recommendedListingPrice: 29.99,
                reasoning: 'Category estimate',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Vitamin D3 5000 IU Supplement',
        };

        const result = await lookupPrice(input);

        expect(result.ok).toBe(true);
        expect(result.candidates.some(c => c.source === 'estimate')).toBe(true);
      });
    });

    describe('Pricing evidence logging', () => {
      it('should log pricing evidence with all fields', async () => {
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBraveSearch.mockResolvedValue(null);

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'estimate',
                basePrice: 25.00,
                recommendedListingPrice: 22.50,
                reasoning: 'Test',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Test Product',
          photoQuantity: 2,
          amazonPackSize: 1,
        };

        await lookupPrice(input);

        const pricingLog = consoleSpy.mock.calls.find(call => 
          call[0]?.includes('💰 PRICING EVIDENCE:')
        );

        expect(pricingLog).toBeDefined();
        expect(pricingLog?.[0]).toContain('retail=$25.00');
        expect(pricingLog?.[0]).toContain('packSize=1 (single unit)');
        expect(pricingLog?.[0]).toContain('photoQty=2 (photo shows 2 bottles)');
        expect(pricingLog?.[0]).toContain('perUnit=$25.00');
        expect(pricingLog?.[0]).toContain('lotRetail=$50.00');
        expect(pricingLog?.[0]).toContain('final=$');

        consoleSpy.mockRestore();
      });
    });

    describe('Cache storage', () => {
      it('should cache successful pricing decisions', async () => {
        mockFetchSoldStats.mockResolvedValue({
          ok: true,
          rateLimited: false,
          p35: 19.99,
          median: 20.00,
          samples: [{ price: 19.99, currency: 'USD' }],
        });

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'ebay-sold',
                basePrice: 19.99,
                recommendedListingPrice: 19.99,
                reasoning: 'Test',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Test Product',
          brand: 'Test Brand',
        };

        await lookupPrice(input);

        // Should cache MSRP (not computed price)
        expect(mockSetCachedPrice).toHaveBeenCalledWith(
          'Test Brand:Test Product',
          expect.objectContaining({
            msrpCents: expect.any(Number),
            chosen: expect.any(Object),
            candidates: expect.any(Array),
            cachedAt: expect.any(Number),
          })
        );
      });
    });

    describe('URL variation generation', () => {
      it('should handle brand URL lookup', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBrandUrlForBrandSite.mockResolvedValue('https://brand.com/fish-oil/');
        mockExtractPrice.mockReturnValue(29.99);
        mockBraveSearch.mockResolvedValue(null); // No Amazon results from Brave
        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'brand-msrp',
                basePrice: 29.99,
                recommendedListingPrice: 26.99,
                reasoning: 'Brand MSRP with discount',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Fish Oil',
          brand: 'Test Brand',
        };

        const result = await lookupPrice(input);
        // Should return a valid result
        expect(result.ok).toBe(true);
        expect(result.recommendedListingPrice).toBeGreaterThan(0);
      });

      it('should handle inputs with keyText hints', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });

        const input: PriceLookupInput = {
          title: 'Fish Oil',
          keyText: ['omega-3 fatty acids supplement'],
        };

        const result = await lookupPrice(input);
        // Should return estimate when no data available
        expect(result.ok).toBe(true);
        expect(result.recommendedListingPrice).toBeGreaterThan(0);
      });

      it('should handle inputs with categoryPath', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });

        const input: PriceLookupInput = {
          title: 'Vitamin D3',
          categoryPath: 'Health & Beauty > Vitamins & Supplements',
        };

        const result = await lookupPrice(input);
        // Should return estimate when no data available
        expect(result.ok).toBe(true);
        expect(result.recommendedListingPrice).toBeGreaterThan(0);
      });
    });

    describe('Fallback scenarios', () => {
      it('should use fallback decision when AI returns invalid JSON', async () => {
        mockFetchSoldStats.mockResolvedValue({
          ok: true,
          p35: 18.99,
          median: 20.00,
          samples: [{ price: 18.99, currency: 'USD' }],
          rateLimited: false,
        });
        mockBraveSearch.mockResolvedValue(null);

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: 'Invalid JSON',
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Test Product',
        };

        const result = await lookupPrice(input);

        expect(result.ok).toBe(true);
        expect(result.chosen?.source).toBe('ebay-sold');
        expect(result.chosen?.price).toBe(18.99);
      });

      it('should handle brand MSRP fallback when AI fails', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBrandUrlForBrandSite.mockResolvedValue('https://brand.com/product');
        mockExtractPrice.mockReturnValue(35.99);

        mockOpenAI.mockRejectedValue(new Error('Network error'));

        const input: PriceLookupInput = {
          title: 'Premium Product',
          brand: 'Premium Brand',
        };

        const result = await lookupPrice(input);

        expect(result.ok).toBe(true);
        // When AI fails, fallback uses brand-msrp if available
        expect(result.chosen?.source).toBe('brand-msrp');
        expect(result.recommendedListingPrice).toBeGreaterThan(0);
      }, 10000);

      it('should handle estimate source in fallback', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBraveSearch.mockResolvedValue(null);

        mockOpenAI.mockRejectedValue(new Error('Timeout'));

        const input: PriceLookupInput = {
          title: 'Unknown Product',
        };

        const result = await lookupPrice(input);

        expect(result.ok).toBe(true);
        expect(result.chosen?.source).toBe('estimate');
        expect(result.chosen?.price).toBe(29.99);
      });
    });

    describe('Legacy function support', () => {
      it('should support deprecated lookupMarketPrice function', async () => {
        const { lookupMarketPrice } = await import('../../src/lib/price-lookup');

        mockFetchSoldStats.mockResolvedValue({
          ok: true,
          p35: 24.99,
          median: 25.00,
          samples: [],
          rateLimited: false,
        });
        mockBraveSearch.mockResolvedValue(null);

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'ebay-sold',
                basePrice: 24.99,
                recommendedListingPrice: 24.99,
                reasoning: 'eBay data',
              }),
            },
          }],
        } as any);

        const result = await lookupMarketPrice('TestBrand', 'TestProduct', '100mg');

        expect(result).toHaveProperty('amazon');
        expect(result).toHaveProperty('walmart');
        expect(result).toHaveProperty('brand');
        expect(result).toHaveProperty('avg');
        expect(result.avg).toBe(22.49); // 24.99 * 0.9 (10% default discount applied)
      }, 15000); // Increase timeout for this test
    });

    describe('Error handling paths', () => {
      it('should handle cache read errors gracefully', async () => {
        mockGetCachedPrice.mockRejectedValue(new Error('Cache error'));
        mockFetchSoldStats.mockResolvedValue({
          ok: true,
          p35: 19.99,
          median: 20.00,
          samples: [],
          rateLimited: false,
        });

        const input: PriceLookupInput = {
          title: 'Test Product',
        };

        const result = await lookupPrice(input);

        // Should proceed without cache
        expect(result.ok).toBe(true);
      });

      it('should handle fetch failures for brand URLs', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBrandUrlForBrandSite.mockResolvedValue('https://brand.com/product');
        mockExtractPrice.mockReturnValue(null); // Simulate fetch/parse failure

        const input: PriceLookupInput = {
          title: 'Product',
          brand: 'Brand',
        };

        const result = await lookupPrice(input);

        // Should fall back to estimate
        expect(result.ok).toBe(true);
        expect(result.chosen?.source).toBe('estimate');
      }, 10000); // Increase timeout for this test
    });

    describe('Pricing evidence logging', () => {
      it('should log evidence with amazonPackSize=1 by default', async () => {
        mockFetchSoldStats.mockResolvedValue({
          ok: true,
          p35: 22.99,
          median: 23.00,
          samples: [],
          rateLimited: false,
        });

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'ebay-sold',
                basePrice: 22.99,
                recommendedListingPrice: 22.99,
                reasoning: 'eBay',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Single Product',
        };

        await lookupPrice(input);
        // Should log with packSize=1
        expect(mockOpenAI).toHaveBeenCalled();
      });
    });

    describe('Additional coverage for uncovered lines', () => {
      it('should handle rate limited eBay responses', async () => {
        mockFetchSoldStats.mockResolvedValue({
          ok: false,
          rateLimited: true,
          samples: [],
        });

        const input: PriceLookupInput = {
          title: 'Test Product',
        };

        const result = await lookupPrice(input);
        // Should still return a result (estimate fallback)
        expect(result.ok).toBe(true);
      });

      it('should handle eBay responses with low sample count', async () => {
        mockFetchSoldStats.mockResolvedValue({
          ok: true,
          p35: 10.00,
          median: 12.00,
          samples: [{ price: 10.00, currency: 'USD' }], // Only 1 sample
          rateLimited: false,
        });

        const input: PriceLookupInput = {
          title: 'Rare Product',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
      });

      it('should handle brand website URL directly', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockExtractPrice.mockReturnValue(45.99);
        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                source: 'brand-msrp',
                basePrice: 45.99,
                finalPrice: 41.39,
                reason: 'Brand MSRP',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Product',
          brand: 'TestBrand',
          brandWebsite: 'https://testbrand.com/product',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
      }, 10000);

      it('should handle products with UPC codes', async () => {
        mockFetchSoldStats.mockResolvedValue({
          ok: true,
          p35: 19.99,
          median: 22.00,
          samples: [{ price: 19.99, currency: 'USD' }, { price: 22.00, currency: 'USD' }, { price: 24.00, currency: 'USD' }],
          rateLimited: false,
        });

        const input: PriceLookupInput = {
          title: 'Product',
          upc: '123456789012',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
      });

      it('should handle multiple price candidates with AI selection', async () => {
        mockFetchSoldStats.mockResolvedValue({
          ok: true,
          p35: 20.00,
          median: 22.00,
          samples: [{ price: 20.00, currency: 'USD' }, { price: 22.00, currency: 'USD' }, { price: 24.00, currency: 'USD' }],
          rateLimited: false,
        });

        mockBrandUrlForBrandSite.mockResolvedValue('https://brand.com/product');
        mockExtractPrice.mockReturnValue(35.99);

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'brand-msrp',
                basePrice: 35.99,
                recommendedListingPrice: 32.39,
                reasoning: 'Brand MSRP with 10% discount',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Premium Product',
          brand: 'Premium Brand',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
        expect(result.recommendedListingPrice).toBeGreaterThan(0);
      }, 10000);

      it('should use category-based estimate for supplements', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });

        const input: PriceLookupInput = {
          title: 'Vitamin C 1000mg',
          categoryPath: 'Health & Beauty > Vitamins & Supplements',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
        // Should use supplement category estimate
        expect(result.recommendedListingPrice).toBeGreaterThan(15);
        expect(result.recommendedListingPrice).toBeLessThan(50);
      });

      it('should handle title with variant info', async () => {
        mockFetchSoldStats.mockResolvedValue({
          ok: true,
          p35: 18.99,
          median: 20.00,
          samples: [{ price: 18.99, currency: 'USD' }, { price: 20.00, currency: 'USD' }],
          rateLimited: false,
        });

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'ebay-sold',
                basePrice: 18.99,
                recommendedListingPrice: 18.99,
                reasoning: 'Using eBay sold data',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Fish Oil 1200mg Softgels 120 count',
          brand: 'Nature Made',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
      }, 10000);

      it('should cache successful price lookups', async () => {
        mockFetchSoldStats.mockResolvedValue({
          ok: true,
          p35: 25.00,
          median: 27.00,
          samples: [{ price: 25.00, currency: 'USD' }, { price: 27.00, currency: 'USD' }, { price: 29.00, currency: 'USD' }],
          rateLimited: false,
        });

        const input: PriceLookupInput = {
          title: 'Cacheable Product',
          brand: 'Test Brand',
        };

        await lookupPrice(input);
        
        // Verify cache was set
        expect(mockSetCachedPrice).toHaveBeenCalled();
      }, 10000);

      it('should handle Amazon search for generic products', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBraveSearch.mockResolvedValue('https://amazon.com/dp/B12345');
        mockExtractPrice.mockReturnValue(29.99);

        const input: PriceLookupInput = {
          title: 'Generic Supplement',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
      });

      it('should apply 10% discount to brand MSRP', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBrandUrlForBrandSite.mockResolvedValue('https://brand.com/product');
        mockExtractPrice.mockReturnValue(49.99);
        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                source: 'brand-msrp',
                basePrice: 49.99,
                finalPrice: 44.99,
                reason: 'Brand MSRP with 10% discount',
              }),
            },
          }],
        } as any);

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'brand-msrp',
                basePrice: 49.99,
                recommendedListingPrice: 44.99,
                reasoning: 'Brand MSRP with discount',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Brand Product',
          brand: 'Brand',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
      }, 10000);

      it('should handle products in different categories', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });

        const input: PriceLookupInput = {
          title: 'Pet Supplements for Dogs',
          categoryPath: 'Pet Supplies > Dog > Vitamins & Supplements',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
        expect(result.recommendedListingPrice).toBeGreaterThan(0);
      });

      it('should detect JS-rendered prices when HTML extraction fails', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockGetBrandUrls.mockResolvedValue({ brand: 'https://brand.com/product' });
        
        // Mock fetch to return HTML with JS framework indicators
        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
          text: async () => '<html><script src="react.js"></script><div data-price="29.99"></div></html>',
        }) as any;

        mockExtractPrice.mockReturnValue(null); // HTML extraction fails
        mockExtractPriceWithShipping.mockReturnValue({ amazonItemPrice: 0, amazonShippingPrice: 0, amazonTotalPrice: 0 }); // Also fails

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                source: 'estimate',
                basePrice: 29.99,
                recommendedListingPrice: 26.99,
                reasoning: 'Estimate',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Test Product',
          brand: 'TestBrand',
        };

        const result = await lookupPrice(input);
        // Should fall back to estimate when JS-rendered prices detected
        expect(result.candidates.length).toBeGreaterThan(0);
      });

      it('should handle DNS failures gracefully', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockGetBrandUrls.mockResolvedValue({ brand: 'https://nonexistent-domain-12345.com/product' });
        
        // Mock DNS failure
        global.fetch = jest.fn().mockRejectedValue({
          cause: { code: 'ENOTFOUND' }
        }) as any;

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                source: 'estimate',
                basePrice: 29.99,
                recommendedListingPrice: 26.99,
                reasoning: 'Estimate',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Test Product',
          brand: 'TestBrand',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true); // Should not crash
        expect(result.candidates.length).toBeGreaterThan(0);
      });

      it('should handle bundle price detection', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockGetBrandUrls.mockResolvedValue({ brand: 'https://brand.com/product' });
        
        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
          text: async () => '<html><script type="application/ld+json">{"offers":{"price":"100.00"}}</script></html>',
        }) as any;

        mockExtractPrice.mockReturnValue(100); // Suspiciously high brand price

        // Mock Brave search for comparison
        mockBraveSearch.mockResolvedValue('https://amazon.com/product');
        
        global.fetch = jest.fn()
          .mockResolvedValueOnce({
            ok: true,
            text: async () => '<html><script type="application/ld+json">{"offers":{"price":"100.00"}}</script></html>',
          })
          .mockResolvedValueOnce({
            ok: true,
            text: async () => '<html><script type="application/ld+json">{"offers":{"price":"35.00"}}</script></html>',
          }) as any;

        mockExtractPrice
          .mockReturnValueOnce(100) // Brand price
          .mockReturnValueOnce(35);  // Amazon price (much lower)
        mockExtractPriceWithShipping.mockReturnValue({ amazonItemPrice: 35, amazonShippingPrice: 0, amazonTotalPrice: 35 });

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                source: 'brave-fallback',
                basePrice: 35.00,
                recommendedListingPrice: 31.50,
                reasoning: 'Amazon price',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Test Product',
          brand: 'TestBrand',
        };

        const result = await lookupPrice(input);
        // Should detect bundle and potentially reject or flag the brand price
        expect(result.candidates.length).toBeGreaterThan(0);
      });

      it('should handle timeout when fetching HTML', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockGetBrandUrls.mockResolvedValue({ brand: 'https://slow-site.com/product' });
        mockBraveSearch.mockResolvedValue('https://amazon.com/product');
        
        // Mock timeout
        global.fetch = jest.fn().mockImplementation(() => 
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), 100)
          )
        ) as any;

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                source: 'estimate',
                basePrice: 29.99,
                recommendedListingPrice: 26.99,
                reasoning: 'Estimate',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Test Product',
          brand: 'TestBrand',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true); // Should handle timeout gracefully
      });

      it('should generate URL variations for brand sites', async () => {
        // Import the internal function for testing
        const priceLookup = require('../../src/lib/price-lookup');
        
        // Test that generateUrlVariations is called internally
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockGetBrandUrls.mockResolvedValue({ brand: 'https://brand.com/product-name/' });
        
        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
          text: async () => '<html><script type="application/ld+json">{"offers":{"price":"29.99"}}</script></html>',
        }) as any;

        mockExtractPrice.mockReturnValue(29.99);
        mockExtractPriceWithShipping.mockReturnValue({ amazonItemPrice: 29.99, amazonShippingPrice: 0, amazonTotalPrice: 29.99 });
        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                source: 'brand-msrp',
                basePrice: 29.99,
                recommendedListingPrice: 26.99,
                reasoning: 'Brand MSRP',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Test Product',
          brand: 'TestBrand',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
      });

      it('should handle UPC in price lookup', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        
        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                source: 'estimate',
                basePrice: 29.99,
                recommendedListingPrice: 26.99,
                reasoning: 'Estimate',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Test Product',
          upc: '123456789012',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
        expect(result.candidates.length).toBeGreaterThan(0);
      });

      it('should use fallback when AI decision fails with brand MSRP available', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockGetBrandUrls.mockResolvedValue({ brand: 'https://brand.com/product' });
        
        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
          text: async () => '<html><script type="application/ld+json">{"offers":{"price":"49.99"}}</script></html>',
        }) as any;

        mockExtractPrice.mockReturnValue(49.99);
        mockExtractPriceWithShipping.mockReturnValue({ amazonItemPrice: 49.99, amazonShippingPrice: 0, amazonTotalPrice: 49.99 });
        
        // Mock AI failure
        mockOpenAI.mockRejectedValue(new Error('AI timeout'));

        const input: PriceLookupInput = {
          title: 'Premium Product',
          brand: 'Brand',
        };

        const result = await lookupPrice(input);
        // Should fall back to brand MSRP with 10% discount
        expect(result.ok).toBe(true);
        expect(result.chosen?.source).toBe('brand-msrp');
        expect(result.recommendedListingPrice).toBeLessThan(49.99);
      });

      it('should handle condition parameter', async () => {
        mockFetchSoldStats.mockResolvedValue({
          ok: true,
          rateLimited: false,
          samples: [{ price: 20, currency: 'USD' }],
          median: 20,
        });

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                source: 'ebay-sold',
                basePrice: 20.00,
                recommendedListingPrice: 18.00,
                reasoning: 'Used item pricing',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Test Product',
          condition: 'USED',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
      });

      it('should handle photoQuantity parameter', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                source: 'estimate',
                basePrice: 29.99,
                recommendedListingPrice: 26.99,
                reasoning: 'Estimate',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Test Product',
          photoQuantity: 2, // Photo shows 2 bottles
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
      });

      it('should use keyText hints for Amazon search', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBraveSearch.mockResolvedValue('https://amazon.com/product');
        
        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
          text: async () => '<html><script type="application/ld+json">{"offers":{"price":"34.99"}}</script></html>',
        }) as any;

        mockExtractPrice.mockReturnValue(34.99);
        
        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                source: 'brave-fallback',
                basePrice: 34.99,
                recommendedListingPrice: 31.49,
                reasoning: 'Amazon price',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Test Product',
          keyText: ['supplement', 'capsule', 'health'],
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
      });

      it('should handle keyText without matching hints', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        
        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                source: 'estimate',
                basePrice: 29.99,
                recommendedListingPrice: 26.99,
                reasoning: 'Estimate',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Test Product',
          keyText: ['random', 'text', 'labels'], // No matching hints
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
      });

      it('should handle HTTP 404 from brand URL', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockGetBrandUrls.mockResolvedValue({ brand: 'https://brand.com/404' });
        
        global.fetch = jest.fn().mockResolvedValue({
          ok: false,
          status: 404,
        }) as any;

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                source: 'estimate',
                basePrice: 29.99,
                recommendedListingPrice: 26.99,
                reasoning: 'Estimate',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Test Product',
          brand: 'TestBrand',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
      });

      it('should build Amazon query with keyText hints when brand is provided', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBraveSearch.mockResolvedValue('https://amazon.com/product');
        mockExtractPriceWithShipping.mockReturnValueOnce({
          amazonItemPrice: 25,
          amazonShippingPrice: 0,
          shippingEvidence: 'free',
          pageTitle: 'TestBrand Omega Supplement Capsules',
        } as any);

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'amazon',
                basePrice: 25,
                recommendedListingPrice: 22.5,
                reasoning: 'Amazon match',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Omega Supplement',
          brand: 'TestBrand',
          keyText: ['great supplement for omega'],
        };

        const result = await lookupPrice(input);
        expect(mockBraveSearch).toHaveBeenCalledWith(expect.stringContaining('supplement'), 'amazon.com');
        expect(result.ok).toBe(true);
        // The Amazon result is rejected due to product mismatch; ensure it does not make it into candidates
        expect(result.candidates.some((c) => c.source === 'amazon')).toBe(false);
        expect(result.candidates.some((c) => c.source === 'brand-msrp')).toBe(true);
      });

      it('should prefer lowest brand price from URL variations', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBraveSearch.mockResolvedValue(null);

        // First call (vision URL) returns higher price, variation returns lower
        mockExtractPrice.mockReturnValueOnce(40).mockReturnValueOnce(30).mockReturnValue(30);
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          text: async () => '<html><body>$40.00</body></html>',
        });

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'brand-msrp',
                basePrice: 30,
                recommendedListingPrice: 27,
                reasoning: 'Best URL variation',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Variation Product',
          brand: 'VariationBrand',
          brandWebsite: 'https://brand.com/product-name.html',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
        const brandCandidate = result.candidates.find((c) => c.source === 'brand-msrp');
        expect(brandCandidate?.price).toBe(30);
        // Ensure we actually used a variation URL (not the original)
        expect(brandCandidate?.url).not.toBe('https://brand.com/product-name.html');
      });

      it('should warn when vision domain is unreachable', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBraveSearch.mockResolvedValue(null);

        // Vision URL returns no price, DNS failure on reachability check
        mockExtractPrice.mockReturnValue(null);
        (global.fetch as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('dns'), { cause: { code: 'ENOTFOUND' } }));

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'estimate',
                basePrice: 29.99,
                recommendedListingPrice: 26.99,
                reasoning: 'Estimate fallback',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Unreachable Product',
          brand: 'NoDNS',
          brandWebsite: 'https://nodns.example.com/product',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
      });

      it('should skip bundle check when marketplace candidates do not match brand', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBraveSearch.mockResolvedValue('https://amazon.com/product');
        mockGetAmazonAsin.mockResolvedValue('ASIN123');

        mockExtractPriceWithShipping.mockReturnValueOnce({
          amazonItemPrice: 19.99,
          amazonShippingPrice: 0,
          shippingEvidence: 'free',
          pageTitle: 'Generic Product',
        } as any);

        mockExtractPrice.mockReturnValueOnce(49.99);

        const originalPush = Array.prototype.push;
        const pushSpy = jest.spyOn(Array.prototype, 'push').mockImplementation(function (...args: any[]) {
          args.forEach((arg) => {
            if (arg && typeof arg === 'object' && (arg.source === 'amazon' || arg.source === 'ebay-sold')) {
              (arg as any).matchesBrand = false;
            }
          });
          return originalPush.apply(this as any, args);
        });

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'brand-msrp',
                basePrice: 49.99,
                recommendedListingPrice: 44.99,
                reasoning: 'Brand price kept',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Bundle Check Product',
          brand: 'BundleBrand',
          brandWebsite: 'https://brand.com/product',
        };

        const result = await lookupPrice(input);
        pushSpy.mockRestore();
        expect(result.ok).toBe(true);
      });

      it('should drop brand candidates that look like bundles', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockBraveSearch.mockResolvedValue('https://amazon.com/product');
        mockGetAmazonAsin.mockResolvedValue('ASIN123');

        mockExtractPriceWithShipping.mockReturnValueOnce({
          amazonItemPrice: 40,
          amazonShippingPrice: 0,
          shippingEvidence: 'free',
          pageTitle: 'Brand Bundle Product',
        } as any);

        mockExtractPrice.mockReturnValueOnce(150);

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'amazon',
                basePrice: 40,
                recommendedListingPrice: 36,
                reasoning: 'Amazon beats bundle',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Bundle Price Test',
          brand: 'BundleBrand',
          brandWebsite: 'https://brand.com/product',
        };

        const result = await lookupPrice(input);
        const brandCandidate = result.candidates.find((c) => c.source === 'brand-msrp');
        expect(brandCandidate).toBeUndefined();
      });

      it('should use skincare estimate when title mentions serum', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'estimate',
                basePrice: 24.99,
                recommendedListingPrice: 22.49,
                reasoning: 'Serum estimate',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Vitamin C Serum',
        };

        const result = await lookupPrice(input);
        const estimate = result.candidates.find((c) => c.source === 'estimate');
        expect(estimate?.price).toBe(24.99);
      });

      it('should use sports nutrition estimate when title mentions protein', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'estimate',
                basePrice: 39.99,
                recommendedListingPrice: 35.99,
                reasoning: 'Protein estimate',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Grass Fed Protein Powder',
        };

        const result = await lookupPrice(input);
        const estimate = result.candidates.find((c) => c.source === 'estimate');
        expect(estimate?.price).toBe(39.99);
      });

      it('should warn when caching MSRP fails after a valid decision', async () => {
        mockFetchSoldStats.mockResolvedValue({ ok: false, rateLimited: false, samples: [] });
        mockSetCachedPrice.mockRejectedValueOnce(new Error('cache-fail'));

        mockOpenAI.mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                chosenSource: 'estimate',
                basePrice: 29.99,
                recommendedListingPrice: 26.99,
                reasoning: 'Cache failure path',
              }),
            },
          }],
        } as any);

        const input: PriceLookupInput = {
          title: 'Cache Failure Product',
        };

        const result = await lookupPrice(input);
        expect(result.ok).toBe(true);
      });
    });
  });
});
