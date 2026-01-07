// tests/lib/pricing/ebay-sold-prices.test.ts
/**
 * Tests for eBay sold prices via SearchAPI.io
 * 
 * Replaces deprecated eBay Finding API tests with SearchAPI.io scraping tests.
 * Validates SearchAPI.io integration for competitive pricing.
 */

import { fetchSoldPriceStats } from '../../../src/lib/pricing/ebay-sold-prices';
import type { SoldPriceQuery } from '../../../src/lib/pricing/ebay-sold-prices';

describe('ebay-sold-prices (SearchAPI.io)', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.SEARCHAPI_KEY = 'test-api-key-12345';
    jest.clearAllMocks();
    global.fetch = jest.fn() as jest.Mock<any>;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('fetchSoldPriceStats', () => {
    it('should fetch and compute statistics from SearchAPI.io eBay sold items', async () => {
      const query: SoldPriceQuery = {
        title: 'iPhone 14 Pro',
        brand: 'Apple',
        condition: 'NEW',
      };

      // Mock SearchAPI.io response - all titles contain matching words
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          organic_results: [
            {
              title: 'Apple iPhone 14 Pro 128GB',
              price: { value: 899.99 },
              link: 'https://ebay.com/itm/item1',
            },
            {
              title: 'Apple iPhone 14 Pro 256GB',
              price: { raw: '$949.00' },
              link: 'https://ebay.com/itm/item2',
            },
            {
              title: 'Apple iPhone 14 Pro',
              price: '$875.50',
              link: 'https://ebay.com/itm/item3',
            },
            {
              title: 'Apple iPhone 14 Pro Gold',
              price: { value: 920.00 },
              link: 'https://ebay.com/itm/item4',
            },
            {
              title: 'Apple iPhone 14 Pro Max',
              price: { value: 910.00 },
              link: 'https://ebay.com/itm/item5',
            },
          ],
        }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(true);
      expect(result.samplesCount).toBe(5);
      expect(result.samples).toHaveLength(5);
      expect(result.samples[0]).toMatchObject({
        price: 899.99,
        currency: 'USD',
        url: 'https://ebay.com/itm/item1',
      });
      
      // Check statistics
      expect(result.median).toBeDefined();
      expect(result.p35).toBeDefined();
      expect(result.p10).toBeDefined();
      expect(result.p90).toBeDefined();
      
      // Median of [875.50, 899.99, 910.00, 920.00, 949.00] should be 910.00
      expect(result.median).toBeCloseTo(910.00, 2);
    });

    it('should handle SearchAPI.io error responses', async () => {
      const query: SoldPriceQuery = {
        title: 'Test Product',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'Invalid query parameter' }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(false);
      expect(result.samples).toHaveLength(0);
      expect(result.rateLimited).toBe(false);
    });

    it('should detect rate limiting (429 status)', async () => {
      const query: SoldPriceQuery = {
        title: 'Test Product',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: 'Rate limit exceeded' }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(false);
      expect(result.rateLimited).toBe(true);
    });

    it('should return empty when no SEARCHAPI_KEY is set', async () => {
      delete process.env.SEARCHAPI_KEY;
      
      const query: SoldPriceQuery = {
        title: 'Test Product',
      };

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(false);
      expect(result.rateLimited).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should build correct SearchAPI.io URL with brand and title', async () => {
      const query: SoldPriceQuery = {
        title: 'Rapunzel Hair Serum',
        brand: 'Gashee',
        condition: 'USED',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          organic_results: [
            { price: { value: 25.00 }, link: 'https://ebay.com/itm/1' },
            { price: { value: 30.00 }, link: 'https://ebay.com/itm/2' },
            { price: { value: 28.00 }, link: 'https://ebay.com/itm/3' },
          ],
        }),
      } as unknown as Response);

      await fetchSoldPriceStats(query);

      const fetchCall = (global.fetch as jest.Mock<any>).mock.calls[0][0] as string;
      expect(fetchCall).toContain('searchapi.io');
      expect(fetchCall).toContain('engine=ebay_search');
      expect(fetchCall).toContain('ebay_domain=ebay.com');
      expect(fetchCall).toContain('q=Gashee+Rapunzel+Hair+Serum');
      expect(fetchCall).toContain('ebay_tbs=LH_Complete%3A1%2CLH_Sold%3A1');
      expect(fetchCall).toContain('LH_ItemCondition%3A3000'); // USED condition
    });

    it('should apply NEW condition filter', async () => {
      const query: SoldPriceQuery = {
        title: 'Test Product',
        condition: 'NEW',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ organic_results: [] }),
      } as unknown as Response);

      await fetchSoldPriceStats(query);

      const fetchCall = (global.fetch as jest.Mock<any>).mock.calls[0][0] as string;
      expect(fetchCall).toContain('LH_ItemCondition%3A1000'); // NEW condition
    });

    it('should return empty when no organic_results', async () => {
      const query: SoldPriceQuery = {
        title: 'Nonexistent Product XYZ123',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          organic_results: [],
        }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(false);
      expect(result.samples).toHaveLength(0);
    });

    it('should parse various price formats from SearchAPI.io', async () => {
      const query: SoldPriceQuery = {
        title: 'Test Product',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          organic_results: [
            { title: 'Test Product Item 1', price: { value: 25.99 } },           // Format 1: price.value
            { title: 'Test Product Item 2', price: { raw: '$30.50' } },           // Format 2: price.raw
            { title: 'Test Product Item 3', price: '$28.75' },                    // Format 3: string price
            { title: 'Test Product Item 4', price: '35.00' },                     // Format 4: numeric string
            { title: 'Test Product Item 5', price: { value: '40.25' } },          // Format 5: string value
          ],
        }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(true);
      expect(result.samplesCount).toBe(5);
      expect(result.samples.map(s => s.price)).toEqual([25.99, 30.50, 28.75, 35.00, 40.25]);
    });

    it('should filter out invalid prices', async () => {
      const query: SoldPriceQuery = {
        title: 'Test Product',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          organic_results: [
            { title: 'Test Product Item 1', price: { value: 25.99 } },            // Valid
            { title: 'Test Product Item 2', price: { value: 0 } },                // Invalid: 0
            { title: 'Test Product Item 3', price: { value: -10 } },              // Invalid: negative
            { title: 'Test Product Item 4', price: { raw: 'Contact for price' } }, // Invalid: no numeric
            { title: 'Test Product Item 5', price: null },                         // Invalid: null
            { title: 'No price field Test Product' },                              // Invalid: missing price
            { title: 'Test Product Item 6', price: { value: 30.00 } },             // Valid
            { title: 'Test Product Item 7', price: { value: 35.00 } },             // Valid (need 3 for ok=true)
          ],
        }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(true); // ok because 3 valid samples
      expect(result.samplesCount).toBe(3); // 3 valid prices
      expect(result.samples.map(s => s.price)).toEqual([25.99, 30.00, 35.00]);
    });

    it('should require at least 3 samples for ok=true', async () => {
      const query: SoldPriceQuery = {
        title: 'Rare Product',
      };

      // Test with 2 samples
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          organic_results: [
            { title: 'Rare Product Item 1', price: { value: 100.00 } },
            { title: 'Rare Product Item 2', price: { value: 110.00 } },
          ],
        }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(false); // Not enough samples
      expect(result.samplesCount).toBe(2);
      expect(result.median).toBeDefined(); // But still computes stats
    });

    it('should compute correct percentiles', async () => {
      const query: SoldPriceQuery = {
        title: 'Test Product',
      };

      // Create 10 samples with known distribution
      const prices = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          organic_results: prices.map((p, i) => ({ title: `Test Product Item ${i + 1}`, price: { value: p } })),
        }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(true);
      expect(result.samplesCount).toBe(10);
      expect(result.median).toBeCloseTo(50, 2);   // 50th percentile
      expect(result.p35).toBeCloseTo(40, 2);      // 35th percentile
      expect(result.p10).toBeCloseTo(10, 2);      // 10th percentile
      expect(result.p90).toBeCloseTo(90, 2);      // 90th percentile
    });

    it('should handle network errors gracefully', async () => {
      const query: SoldPriceQuery = {
        title: 'Test Product',
      };

      (global.fetch as jest.Mock<any>).mockRejectedValueOnce(new Error('Network timeout'));

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(false);
      expect(result.samples).toHaveLength(0);
    });

    it('should use correct Authorization header', async () => {
      const query: SoldPriceQuery = {
        title: 'Test Product',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ organic_results: [] }),
      } as unknown as Response);

      await fetchSoldPriceStats(query);

      const fetchCall = (global.fetch as jest.Mock<any>).mock.calls[0];
      const headers = fetchCall[1]?.headers;
      expect(headers.Authorization).toBe('Bearer test-api-key-12345');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should handle comma-separated thousands in price strings', async () => {
      const query: SoldPriceQuery = {
        title: 'Expensive Item',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          organic_results: [
            { title: 'Expensive Item Deluxe', price: { raw: '$1,299.99' } },
            { title: 'Expensive Item Premium', price: '$2,500.00' },
            { title: 'Expensive Item Pro', price: { raw: '$3,750.50' } },
          ],
        }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(true);
      expect(result.samples.map(s => s.price)).toEqual([1299.99, 2500.00, 3750.50]);
    });
  });

  describe('Rate limiting', () => {
    it('should enforce 1-second rate limit between calls', async () => {
      const query: SoldPriceQuery = {
        title: 'Test Product',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: true,
        json: async () => ({
          organic_results: [{ price: { value: 25.00 } }],
        }),
      } as unknown as Response);

      const start = Date.now();
      
      // Make 3 consecutive calls
      await fetchSoldPriceStats(query);
      await fetchSoldPriceStats(query);
      await fetchSoldPriceStats(query);
      
      const elapsed = Date.now() - start;
      
      // Should take at least 2 seconds (2 delays between 3 calls)
      expect(elapsed).toBeGreaterThanOrEqual(2000);
    }, 10000); // 10s timeout for rate limit test
  });

  describe('Regression tests - Gashee pricing', () => {
    it('should maintain Gashee pricing behavior', async () => {
      const query: SoldPriceQuery = {
        title: 'Rapunzel Hair Serum',
        brand: 'Gashee',
        condition: 'USED',
      };

      // Simulate typical Gashee response from SearchAPI.io
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          organic_results: [
            { title: 'Gashee Rapunzel Hair Serum 3oz', price: { value: 53.88 }, link: 'https://ebay.com/itm/1' },
            { title: 'Gashee Rapunzel Hair Serum New', price: { value: 83.97 }, link: 'https://ebay.com/itm/2' },
            { title: 'Gashee Rapunzel Hair Serum', price: { value: 21.00 }, link: 'https://ebay.com/itm/3' },
          ],
        }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(true);
      expect(result.samplesCount).toBe(3);
      expect(result.median).toBeCloseTo(53.88, 2);
      
      // Verify it builds the correct query
      const fetchCall = (global.fetch as jest.Mock<any>).mock.calls[0][0] as string;
      expect(fetchCall).toContain('q=Gashee+Rapunzel+Hair+Serum');
    });
  });
});
