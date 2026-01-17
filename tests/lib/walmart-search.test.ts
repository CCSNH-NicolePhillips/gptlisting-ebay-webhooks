/**
 * Tests for Walmart Search via SearchAPI.io
 */

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Set env before imports
process.env.SEARCHAPI_KEY = 'test-api-key';

import { 
  searchWalmart, 
  getWalmartPrice,
  type WalmartSearchResult,
} from '../../src/lib/walmart-search.js';

describe('walmart-search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SEARCHAPI_KEY = 'test-api-key';
  });

  describe('searchWalmart', () => {
    it('should return low confidence when SEARCHAPI_KEY is not configured', async () => {
      delete process.env.SEARCHAPI_KEY;
      
      jest.resetModules();
      const { searchWalmart: search } = await import('../../src/lib/walmart-search.js');
      
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

      await searchWalmart('TestBrand', 'Test Product');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('engine=walmart_search')
      );
    });

    it('should return null price when no results found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: [] }),
      });

      const result = await searchWalmart('UnknownBrand', 'Unknown Product');

      expect(result.price).toBeNull();
      expect(result.confidence).toBe('low');
      expect(result.reasoning).toContain('No products found');
    });

    it('should return best matching product with price', async () => {
      const mockResults: WalmartSearchResult[] = [
        {
          id: 'WM123',
          product_id: '123456',
          title: 'TestBrand Vitamin C 60 Capsules',
          link: 'https://walmart.com/ip/123456',
          extracted_price: 19.99,
          rating: 4.5,
          reviews: 150,
          seller_name: 'Walmart.com',
          two_day_shipping: true,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: mockResults }),
      });

      const result = await searchWalmart('TestBrand', 'Vitamin C 60 Capsules');

      expect(result.price).toBe(19.99);
      expect(result.productId).toBe('123456');
      expect(result.isTwoDayShipping).toBe(true);
      expect(result.seller).toBe('Walmart.com');
    });

    it('should filter out brand mismatches', async () => {
      const mockResults: WalmartSearchResult[] = [
        {
          id: 'WM1',
          product_id: '111',
          title: 'OtherBrand Vitamin C 60 Capsules',
          link: 'https://walmart.com/ip/111',
          extracted_price: 14.99,
        },
        {
          id: 'WM2',
          product_id: '222',
          title: 'TestBrand Vitamin C 60 Capsules',
          link: 'https://walmart.com/ip/222',
          extracted_price: 19.99,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: mockResults }),
      });

      const result = await searchWalmart('TestBrand', 'Vitamin C');

      expect(result.productId).toBe('222');
      expect(result.price).toBe(19.99);
    });

    it('should filter out lot/bundle listings', async () => {
      const mockResults: WalmartSearchResult[] = [
        {
          id: 'WM1',
          product_id: '111',
          title: 'TestBrand Vitamin C (Pack of 3)',
          link: 'https://walmart.com/ip/111',
          extracted_price: 49.99,
        },
        {
          id: 'WM2',
          product_id: '222',
          title: 'TestBrand Vitamin C 60 Capsules',
          link: 'https://walmart.com/ip/222',
          extracted_price: 19.99,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: mockResults }),
      });

      const result = await searchWalmart('TestBrand', 'Vitamin C');

      expect(result.productId).toBe('222');
      expect(result.price).toBe(19.99);
    });

    it('should skip results without price', async () => {
      const mockResults: WalmartSearchResult[] = [
        {
          id: 'WM1',
          product_id: '111',
          title: 'TestBrand Vitamin C',
          link: 'https://walmart.com/ip/111',
          // No extracted_price
        },
        {
          id: 'WM2',
          product_id: '222',
          title: 'TestBrand Vitamin C 60ct',
          link: 'https://walmart.com/ip/222',
          extracted_price: 19.99,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: mockResults }),
      });

      const result = await searchWalmart('TestBrand', 'Vitamin C');

      expect(result.productId).toBe('222');
    });

    it('should handle API errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const result = await searchWalmart('TestBrand', 'Product');

      expect(result.price).toBeNull();
      expect(result.confidence).toBe('low');
      expect(result.reasoning).toContain('API error');
    });

    it('should handle network errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

      const result = await searchWalmart('TestBrand', 'Product');

      expect(result.price).toBeNull();
      expect(result.confidence).toBe('low');
      expect(result.reasoning).toContain('Network timeout');
    });

    it('should handle API response with error field', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ error: 'Rate limit exceeded' }),
      });

      const result = await searchWalmart('TestBrand', 'Product');

      expect(result.price).toBeNull();
      expect(result.reasoning).toBe('Rate limit exceeded');
    });

    it('should prefer Walmart.com as seller', async () => {
      const mockResults: WalmartSearchResult[] = [
        {
          id: 'WM1',
          product_id: '111',
          title: 'TestBrand Vitamin C',
          link: 'https://walmart.com/ip/111',
          extracted_price: 17.99,
          seller_name: 'Third Party Seller',
        },
        {
          id: 'WM2',
          product_id: '222',
          title: 'TestBrand Vitamin C 60ct',
          link: 'https://walmart.com/ip/222',
          extracted_price: 19.99,
          seller_name: 'Walmart.com',
          two_day_shipping: true,
          rating: 4.5,
          reviews: 100,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: mockResults }),
      });

      const result = await searchWalmart('TestBrand', 'Vitamin C');

      // Should pick Walmart.com seller despite higher price
      expect(result.productId).toBe('222');
      expect(result.seller).toBe('Walmart.com');
    });

    it('should penalize sponsored results', async () => {
      const mockResults: WalmartSearchResult[] = [
        {
          id: 'WM1',
          product_id: '111',
          title: 'TestBrand Vitamin C',
          link: 'https://walmart.com/ip/111',
          extracted_price: 19.99,
          sponsored: true,
        },
        {
          id: 'WM2',
          product_id: '222',
          title: 'TestBrand Vitamin C 60ct',
          link: 'https://walmart.com/ip/222',
          extracted_price: 19.99,
          sponsored: false,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: mockResults }),
      });

      const result = await searchWalmart('TestBrand', 'Vitamin C');

      // Should prefer non-sponsored result
      expect(result.productId).toBe('222');
    });
  });

  describe('getWalmartPrice', () => {
    it('should return price and source when found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          organic_results: [{
            id: 'WM1',
            product_id: '123',
            title: 'TestBrand Product',
            link: 'https://walmart.com/ip/123',
            extracted_price: 24.99,
          }],
        }),
      });

      const result = await getWalmartPrice('TestBrand', 'Product');

      expect(result.price).toBe(24.99);
      expect(result.source).toBe('walmart-direct');
    });

    it('should return null price when not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: [] }),
      });

      const result = await getWalmartPrice('UnknownBrand', 'Product');

      expect(result.price).toBeNull();
      expect(result.source).toBe('walmart-not-found');
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
      const mockResults: WalmartSearchResult[] = [
        {
          id: 'WM1',
          product_id: '111',
          title: bundleTitle,
          link: 'https://walmart.com/ip/111',
          extracted_price: 59.99,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ organic_results: mockResults }),
      });

      const result = await searchWalmart('TestBrand', 'Product');

      expect(result.price).toBeNull();
      expect(result.reasoning).toContain('No matching products');
    });
  });
});
