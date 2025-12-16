// tests/lib/pricing/ebay-sold-prices.test.ts
import { fetchSoldPriceStats } from '../../../src/lib/pricing/ebay-sold-prices';
import type { SoldPriceQuery } from '../../../src/lib/pricing/ebay-sold-prices';

describe('ebay-sold-prices', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.EBAY_APP_ID = 'test-app-id-12345';
    process.env.EBAY_ENV = 'production';
    jest.clearAllMocks();
    global.fetch = jest.fn() as jest.Mock<any>;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('fetchSoldPriceStats', () => {
    it('should fetch and compute statistics from sold items', async () => {
      const query: SoldPriceQuery = {
        title: 'Apple iPhone 14 Pro',
        brand: 'Apple',
        condition: 'NEW',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          findCompletedItemsResponse: [
            {
              searchResult: [
                {
                  '@count': '5',
                  item: [
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '899.99', '@currencyId': 'USD' }] }],
                      viewItemURL: ['https://ebay.com/item1'],
                      listingInfo: [{ endTime: ['2023-11-15T10:00:00Z'] }],
                      quantity: ['1'],
                    },
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '949.00', '@currencyId': 'USD' }] }],
                      viewItemURL: ['https://ebay.com/item2'],
                      listingInfo: [{ endTime: ['2023-11-16T10:00:00Z'] }],
                      quantity: ['1'],
                    },
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '875.50', '@currencyId': 'USD' }] }],
                      viewItemURL: ['https://ebay.com/item3'],
                      listingInfo: [{ endTime: ['2023-11-17T10:00:00Z'] }],
                      quantity: ['1'],
                    },
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '920.00', '@currencyId': 'USD' }] }],
                      viewItemURL: ['https://ebay.com/item4'],
                      listingInfo: [{ endTime: ['2023-11-18T10:00:00Z'] }],
                      quantity: ['1'],
                    },
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '910.00', '@currencyId': 'USD' }] }],
                      viewItemURL: ['https://ebay.com/item5'],
                      listingInfo: [{ endTime: ['2023-11-19T10:00:00Z'] }],
                      quantity: ['1'],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(true);
      expect(result.samples).toHaveLength(5);
      expect(result.samples[0]).toMatchObject({
        price: 899.99,
        currency: 'USD',
        url: 'https://ebay.com/item1',
        endedAt: '2023-11-15T10:00:00Z',
      });
      
      // Check statistics
      expect(result.median).toBeDefined();
      expect(result.p35).toBeDefined();
      expect(result.p10).toBeDefined();
      expect(result.p90).toBeDefined();
      
      // Median of [875.50, 899.99, 910.00, 920.00, 949.00] should be 910.00
      expect(result.median).toBeCloseTo(910.00, 2);
    });

    it('should use sandbox URL when EBAY_ENV is sandbox', async () => {
      process.env.EBAY_ENV = 'sandbox';
      
      const query: SoldPriceQuery = {
        title: 'Test Product',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          findCompletedItemsResponse: [
            {
              searchResult: [
                {
                  '@count': '0',
                  item: [],
                },
              ],
            },
          ],
        }),
      } as unknown as Response);

      await fetchSoldPriceStats(query);

      expect((global.fetch as jest.Mock<any>).mock.calls[0][0]).toContain('svcs.sandbox.ebay.com');
    });

    it('should use production URL by default', async () => {
      const query: SoldPriceQuery = {
        title: 'Test Product',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          findCompletedItemsResponse: [
            {
              searchResult: [
                {
                  '@count': '0',
                  item: [],
                },
              ],
            },
          ],
        }),
      } as unknown as Response);

      await fetchSoldPriceStats(query);

      expect((global.fetch as jest.Mock<any>).mock.calls[0][0]).toContain('svcs.ebay.com');
      expect((global.fetch as jest.Mock<any>).mock.calls[0][0]).not.toContain('sandbox');
    });

    it('should combine brand and title in keywords', async () => {
      const query: SoldPriceQuery = {
        title: 'iPhone 14 Pro',
        brand: 'Apple',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          findCompletedItemsResponse: [
            {
              searchResult: [{ '@count': '0', item: [] }],
            },
          ],
        }),
      } as unknown as Response);

      await fetchSoldPriceStats(query);

      const callUrl = (global.fetch as jest.Mock<any>).mock.calls[0][0];
      expect(callUrl).toContain('keywords=Apple+iPhone+14+Pro');
    });

    it('should filter by NEW condition', async () => {
      const query: SoldPriceQuery = {
        title: 'Product',
        condition: 'NEW',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          findCompletedItemsResponse: [
            {
              searchResult: [{ '@count': '0', item: [] }],
            },
          ],
        }),
      } as unknown as Response);

      await fetchSoldPriceStats(query);

      const callUrl = (global.fetch as jest.Mock<any>).mock.calls[0][0];
      expect(callUrl).toContain('itemFilter');
      expect(callUrl).toContain('Condition');
      expect(callUrl).toContain('1000'); // New condition ID
    });

    it('should filter by USED condition', async () => {
      const query: SoldPriceQuery = {
        title: 'Product',
        condition: 'USED',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          findCompletedItemsResponse: [
            {
              searchResult: [{ '@count': '0', item: [] }],
            },
          ],
        }),
      } as unknown as Response);

      await fetchSoldPriceStats(query);

      const callUrl = (global.fetch as jest.Mock<any>).mock.calls[0][0];
      expect(callUrl).toContain('Condition');
      expect(callUrl).toContain('3000'); // Used condition ID
    });

    it('should skip items with invalid or zero prices', async () => {
      const query: SoldPriceQuery = {
        title: 'Product',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          findCompletedItemsResponse: [
            {
              searchResult: [
                {
                  '@count': '4',
                  item: [
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '100.00', '@currencyId': 'USD' }] }],
                      quantity: ['1'],
                    },
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '0', '@currencyId': 'USD' }] }],
                      quantity: ['1'],
                    },
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: 'invalid', '@currencyId': 'USD' }] }],
                      quantity: ['1'],
                    },
                    {
                      sellingStatus: [{}], // Missing currentPrice
                      quantity: ['1'],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.samples).toHaveLength(1);
      expect(result.samples[0].price).toBe(100.00);
    });

    it('should filter by quantity with 20% tolerance', async () => {
      const query: SoldPriceQuery = {
        title: 'Product',
        quantity: 100,
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          findCompletedItemsResponse: [
            {
              searchResult: [
                {
                  '@count': '5',
                  item: [
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '50.00', '@currencyId': 'USD' }] }],
                      quantity: ['100'], // Exact match
                    },
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '51.00', '@currencyId': 'USD' }] }],
                      quantity: ['90'], // Within 20% (80-120)
                    },
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '52.00', '@currencyId': 'USD' }] }],
                      quantity: ['115'], // Within 20%
                    },
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '53.00', '@currencyId': 'USD' }] }],
                      quantity: ['70'], // Below 20% threshold
                    },
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '54.00', '@currencyId': 'USD' }] }],
                      quantity: ['130'], // Above 20% threshold
                    },
                  ],
                },
              ],
            },
          ],
        }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.samples).toHaveLength(3);
      expect(result.samples.map((s: any) => s.price)).toEqual([50.00, 51.00, 52.00]);
    });

    it('should return ok=false when fewer than 3 samples', async () => {
      const query: SoldPriceQuery = {
        title: 'Rare Product',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          findCompletedItemsResponse: [
            {
              searchResult: [
                {
                  '@count': '2',
                  item: [
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '100.00', '@currencyId': 'USD' }] }],
                      quantity: ['1'],
                    },
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '110.00', '@currencyId': 'USD' }] }],
                      quantity: ['1'],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(false);
      expect(result.samples).toHaveLength(2);
      expect(result.median).toBeDefined();
    });

    it('should handle empty search results', async () => {
      const query: SoldPriceQuery = {
        title: 'Nonexistent Product',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          findCompletedItemsResponse: [
            {
              searchResult: [
                {
                  '@count': '0',
                  item: [],
                },
              ],
            },
          ],
        }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(false);
      expect(result.samples).toHaveLength(0);
      expect(result.median).toBeUndefined();
    });

    it('should handle rate limit errors', async () => {
      const query: SoldPriceQuery = {
        title: 'Product',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'You have exceeded the number of times you can call this API',
      } as unknown as Response);

      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(false);
      expect(result.rateLimited).toBe(true);
      expect(result.samples).toHaveLength(0);
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Rate limit exceeded'));

      consoleWarnSpy.mockRestore();
    });

    it('should handle API errors', async () => {
      const query: SoldPriceQuery = {
        title: 'Product',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'Invalid request parameters',
      } as unknown as Response);

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(false);
      expect(result.samples).toHaveLength(0);
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should handle network errors', async () => {
      const query: SoldPriceQuery = {
        title: 'Product',
      };

      (global.fetch as jest.Mock<any>).mockRejectedValueOnce(new Error('Network error'));

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(false);
      expect(result.samples).toHaveLength(0);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error fetching sold prices'),
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });

    it('should return empty result when EBAY_APP_ID is missing', async () => {
      delete process.env.EBAY_APP_ID;
      delete process.env.EBAY_CLIENT_ID;

      const query: SoldPriceQuery = {
        title: 'Product',
      };

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(false);
      expect(result.samples).toHaveLength(0);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Missing EBAY_APP_ID'));
      expect(global.fetch).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should use EBAY_CLIENT_ID as fallback for EBAY_APP_ID', async () => {
      delete process.env.EBAY_APP_ID;
      process.env.EBAY_CLIENT_ID = 'client-id-fallback';

      const query: SoldPriceQuery = {
        title: 'Product',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          findCompletedItemsResponse: [
            {
              searchResult: [{ '@count': '0', item: [] }],
            },
          ],
        }),
      } as unknown as Response);

      await fetchSoldPriceStats(query);

      const callUrl = (global.fetch as jest.Mock<any>).mock.calls[0][0];
      expect(callUrl).toContain('SECURITY-APPNAME=client-id-fallback');
    });

    it('should round prices to 2 decimal places', async () => {
      const query: SoldPriceQuery = {
        title: 'Product',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          findCompletedItemsResponse: [
            {
              searchResult: [
                {
                  '@count': '3',
                  item: [
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '12.345', '@currencyId': 'USD' }] }],
                      quantity: ['1'],
                    },
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '23.456', '@currencyId': 'USD' }] }],
                      quantity: ['1'],
                    },
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '34.567', '@currencyId': 'USD' }] }],
                      quantity: ['1'],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.samples[0].price).toBe(12.35);
      expect(result.samples[1].price).toBe(23.46);
      expect(result.samples[2].price).toBe(34.57);
    });

    it('should include all API filters in request', async () => {
      const query: SoldPriceQuery = {
        title: 'Product',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          findCompletedItemsResponse: [
            {
              searchResult: [{ '@count': '0', item: [] }],
            },
          ],
        }),
      } as unknown as Response);

      await fetchSoldPriceStats(query);

      const callUrl = (global.fetch as jest.Mock<any>).mock.calls[0][0];
      
      // Check for required filters
      expect(callUrl).toContain('SoldItemsOnly');
      expect(callUrl).toContain('true');
      expect(callUrl).toContain('ListingType');
      expect(callUrl).toContain('FixedPrice');
      expect(callUrl).toContain('LocatedIn');
      expect(callUrl).toContain('US');
    });

    it('should compute correct percentiles', async () => {
      const query: SoldPriceQuery = {
        title: 'Product',
      };

      // Prices: 10, 20, 30, 40, 50, 60, 70, 80, 90, 100
      const items = Array.from({ length: 10 }, (_, i) => ({
        sellingStatus: [{ currentPrice: [{ __value__: `${(i + 1) * 10}`, '@currencyId': 'USD' }] }],
        quantity: ['1'],
      }));

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          findCompletedItemsResponse: [
            {
              searchResult: [
                {
                  '@count': '10',
                  item: items,
                },
              ],
            },
          ],
        }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.ok).toBe(true);
      expect(result.samples).toHaveLength(10);
      
      // Median (50th percentile) of [10, 20, ..., 100] should be 55
      expect(result.median).toBeCloseTo(55, 1);
      
      // 35th percentile
      expect(result.p35).toBeCloseTo(41.5, 1);
      
      // 10th percentile
      expect(result.p10).toBeCloseTo(19, 1);
      
      // 90th percentile
      expect(result.p90).toBeCloseTo(91, 1);
    });

    it('should handle items without viewItemURL or endTime', async () => {
      const query: SoldPriceQuery = {
        title: 'Product',
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          findCompletedItemsResponse: [
            {
              searchResult: [
                {
                  '@count': '3',
                  item: [
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '100.00', '@currencyId': 'USD' }] }],
                      quantity: ['1'],
                      // No viewItemURL or listingInfo
                    },
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '110.00', '@currencyId': 'USD' }] }],
                      quantity: ['1'],
                      viewItemURL: ['https://ebay.com/item2'],
                      // No listingInfo
                    },
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '120.00', '@currencyId': 'USD' }] }],
                      quantity: ['1'],
                      // No viewItemURL
                      listingInfo: [{ endTime: ['2023-11-20T10:00:00Z'] }],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.samples).toHaveLength(3);
      expect(result.samples[0].url).toBeUndefined();
      expect(result.samples[0].endedAt).toBeUndefined();
      expect(result.samples[1].url).toBe('https://ebay.com/item2');
      expect(result.samples[1].endedAt).toBeUndefined();
      expect(result.samples[2].url).toBeUndefined();
      expect(result.samples[2].endedAt).toBe('2023-11-20T10:00:00Z');
    });

    it('should default quantity to 1 when missing', async () => {
      const query: SoldPriceQuery = {
        title: 'Product',
        quantity: 1,
      };

      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          findCompletedItemsResponse: [
            {
              searchResult: [
                {
                  '@count': '2',
                  item: [
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '100.00', '@currencyId': 'USD' }] }],
                      // No quantity field
                    },
                    {
                      sellingStatus: [{ currentPrice: [{ __value__: '110.00', '@currencyId': 'USD' }] }],
                      quantity: ['1'],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      } as unknown as Response);

      const result = await fetchSoldPriceStats(query);

      expect(result.samples).toHaveLength(2);
    });
  });
});
