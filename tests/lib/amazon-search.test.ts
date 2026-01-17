/**
 * Tests for Amazon Search via SearchAPI.io
 */

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Set env before imports
process.env.SEARCHAPI_KEY = 'test-api-key';

import { 
  searchAmazon, 
  getAmazonPrice, 
  searchAmazonWithFallback,
  type AmazonSearchResult,
  type AmazonSearchResponse 
} from '../../src/lib/amazon-search.js';

describe('amazon-search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SEARCHAPI_KEY = 'test-api-key';
  });

  describe('searchAmazon', () => {
    it('should return low confidence when SEARCHAPI_KEY is not configured', async () => {
      delete process.env.SEARCHAPI_KEY;
      
      // Need to re-import to pick up env change
      jest.resetModules();
      const { searchAmazon: search } = await import('../../src/lib/amazon-search.js');
      
      const result = await search('TestBrand', 'TestProduct');
      
      expect(result.price).toBeNull();
      expect(result.confidence).toBe('low');
      expect(result.reasoning).toContain('not configured');
    });

    it('should call SearchAPI with correct parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: [] }),
      });

      await searchAmazon('Panda\'s Promise', 'Immune Gummies 60ct');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('engine=amazon_search')
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('amazon_domain=amazon.com')
      );
    });

    it('should return null price when no results found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: [] }),
      });

      const result = await searchAmazon('UnknownBrand', 'Unknown Product');

      expect(result.price).toBeNull();
      expect(result.confidence).toBe('low');
      expect(result.reasoning).toContain('No products found');
    });

    it('should return best matching product with price', async () => {
      const mockResults: AmazonSearchResult[] = [
        {
          position: 1,
          asin: 'B0ABC123',
          title: 'TestBrand Vitamin C 60 Capsules',
          link: 'https://amazon.com/dp/B0ABC123',
          brand: 'TestBrand',
          extracted_price: 24.99,
          rating: 4.5,
          reviews: 150,
          is_prime: true,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: mockResults }),
      });

      const result = await searchAmazon('TestBrand', 'Vitamin C 60 Capsules');

      expect(result.price).toBe(24.99);
      expect(result.asin).toBe('B0ABC123');
      expect(result.isPrime).toBe(true);
      expect(result.confidence).toBe('high');
    });

    it('should filter out brand mismatches', async () => {
      const mockResults: AmazonSearchResult[] = [
        {
          position: 1,
          asin: 'B0WRONG',
          title: 'OtherBrand Vitamin C 60 Capsules',
          link: 'https://amazon.com/dp/B0WRONG',
          brand: 'OtherBrand',
          extracted_price: 19.99,
        },
        {
          position: 2,
          asin: 'B0RIGHT',
          title: 'TestBrand Vitamin C 60 Capsules',
          link: 'https://amazon.com/dp/B0RIGHT',
          brand: 'TestBrand',
          extracted_price: 24.99,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: mockResults }),
      });

      const result = await searchAmazon('TestBrand', 'Vitamin C');

      expect(result.asin).toBe('B0RIGHT');
      expect(result.price).toBe(24.99);
    });

    it('should filter out lot/bundle listings', async () => {
      const mockResults: AmazonSearchResult[] = [
        {
          position: 1,
          asin: 'B0BUNDLE',
          title: 'TestBrand Vitamin C (Pack of 3)',
          link: 'https://amazon.com/dp/B0BUNDLE',
          brand: 'TestBrand',
          extracted_price: 59.99,
        },
        {
          position: 2,
          asin: 'B0SINGLE',
          title: 'TestBrand Vitamin C 60 Capsules',
          link: 'https://amazon.com/dp/B0SINGLE',
          brand: 'TestBrand',
          extracted_price: 24.99,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: mockResults }),
      });

      const result = await searchAmazon('TestBrand', 'Vitamin C');

      expect(result.asin).toBe('B0SINGLE');
      expect(result.price).toBe(24.99);
    });

    it('should skip results without price', async () => {
      const mockResults: AmazonSearchResult[] = [
        {
          position: 1,
          asin: 'B0NOPRICE',
          title: 'TestBrand Vitamin C',
          link: 'https://amazon.com/dp/B0NOPRICE',
          brand: 'TestBrand',
          // No extracted_price
        },
        {
          position: 2,
          asin: 'B0WITHPRICE',
          title: 'TestBrand Vitamin C 60ct',
          link: 'https://amazon.com/dp/B0WITHPRICE',
          brand: 'TestBrand',
          extracted_price: 24.99,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: mockResults }),
      });

      const result = await searchAmazon('TestBrand', 'Vitamin C');

      expect(result.asin).toBe('B0WITHPRICE');
    });

    it('should handle API errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const result = await searchAmazon('TestBrand', 'Product');

      expect(result.price).toBeNull();
      expect(result.confidence).toBe('low');
      expect(result.reasoning).toContain('API error');
    });

    it('should handle network errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

      const result = await searchAmazon('TestBrand', 'Product');

      expect(result.price).toBeNull();
      expect(result.confidence).toBe('low');
      expect(result.reasoning).toContain('Network timeout');
    });

    it('should handle API response with error field', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ error: 'Rate limit exceeded' }),
      });

      const result = await searchAmazon('TestBrand', 'Product');

      expect(result.price).toBeNull();
      expect(result.reasoning).toBe('Rate limit exceeded');
    });

    it('should prefer Prime and Overall Pick results', async () => {
      const mockResults: AmazonSearchResult[] = [
        {
          position: 1,
          asin: 'B0REGULAR',
          title: 'TestBrand Vitamin C',
          link: 'https://amazon.com/dp/B0REGULAR',
          brand: 'TestBrand',
          extracted_price: 22.99,
          is_prime: false,
        },
        {
          position: 2,
          asin: 'B0PRIMEPICK',
          title: 'TestBrand Vitamin C 60ct',
          link: 'https://amazon.com/dp/B0PRIMEPICK',
          brand: 'TestBrand',
          extracted_price: 24.99,
          is_prime: true,
          is_overall_pick: true,
          rating: 4.8,
          reviews: 200,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: mockResults }),
      });

      const result = await searchAmazon('TestBrand', 'Vitamin C');

      // Should pick the Prime + Overall Pick despite higher price
      expect(result.asin).toBe('B0PRIMEPICK');
    });
  });

  describe('getAmazonPrice', () => {
    it('should return price and source when found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          organic_results: [{
            position: 1,
            asin: 'B0TEST',
            title: 'TestBrand Product',
            link: 'https://amazon.com/dp/B0TEST',
            brand: 'TestBrand',
            extracted_price: 29.99,
          }],
        }),
      });

      const result = await getAmazonPrice('TestBrand', 'Product');

      expect(result.price).toBe(29.99);
      expect(result.source).toBe('amazon-direct');
    });

    it('should return null price when not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: [] }),
      });

      const result = await getAmazonPrice('UnknownBrand', 'Product');

      expect(result.price).toBeNull();
      expect(result.source).toBe('amazon-not-found');
    });
  });

  describe('searchAmazonWithFallback', () => {
    it('should return full search result when confident', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          organic_results: [{
            position: 1,
            asin: 'B0TEST',
            title: 'TestBrand Product 60ct',
            link: 'https://amazon.com/dp/B0TEST',
            brand: 'TestBrand',
            extracted_price: 29.99,
            reviews: 100,
          }],
        }),
      });

      const result = await searchAmazonWithFallback('TestBrand', 'Product 60ct');

      expect(result.price).toBe(29.99);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should try brand-only search when full search fails', async () => {
      // First call - full search returns no results
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: [] }),
      });

      // Second call - brand-only search succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          organic_results: [{
            position: 1,
            asin: 'B0BRANDONLY',
            title: 'Milamend Hormone Balance',
            link: 'https://amazon.com/dp/B0BRANDONLY',
            brand: 'Milamend',
            extracted_price: 49.99,
          }],
        }),
      });

      const result = await searchAmazonWithFallback('Milamend', 'Some Other Product Name');

      expect(result.price).toBe(49.99);
      expect(result.reasoning).toContain('Brand-only fallback');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should not try brand-only when tryBrandOnly is false', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: [] }),
      });

      const result = await searchAmazonWithFallback('TestBrand', 'Product', false);

      expect(result.price).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should not try brand-only when brand is too short', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: [] }),
      });

      const result = await searchAmazonWithFallback('AB', 'Product');

      expect(result.price).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('lot/bundle detection patterns', () => {
    const bundlePatterns = [
      'TestBrand Product (Pack of 3)',
      'TestBrand Product 2-Pack',
      'TestBrand Product 3 Pack',
      'TestBrand Product, 4 pack',
      'TestBrand Product Bundle of 2',
      'TestBrand Product Set of 3',
      'TestBrand Product Qty: 2',
    ];

    test.each(bundlePatterns)('should filter out: %s', async (bundleTitle) => {
      const mockResults: AmazonSearchResult[] = [
        {
          position: 1,
          asin: 'B0BUNDLE',
          title: bundleTitle,
          link: 'https://amazon.com/dp/B0BUNDLE',
          brand: 'TestBrand',
          extracted_price: 59.99,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: mockResults }),
      });

      const result = await searchAmazon('TestBrand', 'Product');

      expect(result.price).toBeNull();
      expect(result.reasoning).toContain('No matching products');
    });
  });
});
