/**
 * Tests for Multi-Source Pricing Search
 */

// Mock the individual search modules
jest.mock('../../src/lib/google-shopping-search.js', () => ({
  searchGoogleShopping: jest.fn(),
}));

jest.mock('../../src/lib/amazon-search.js', () => ({
  searchAmazonWithFallback: jest.fn(),
}));

jest.mock('../../src/lib/walmart-search.js', () => ({
  searchWalmart: jest.fn(),
}));

import { 
  searchMultipleSources, 
  getBestRetailPrice,
  type MultiSourcePriceResult 
} from '../../src/lib/multi-source-pricing.js';
import { searchGoogleShopping } from '../../src/lib/google-shopping-search.js';
import { searchAmazonWithFallback } from '../../src/lib/amazon-search.js';
import { searchWalmart } from '../../src/lib/walmart-search.js';

const mockGoogleShopping = searchGoogleShopping as jest.MockedFunction<typeof searchGoogleShopping>;
const mockAmazon = searchAmazonWithFallback as jest.MockedFunction<typeof searchAmazonWithFallback>;
const mockWalmart = searchWalmart as jest.MockedFunction<typeof searchWalmart>;

describe('multi-source-pricing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('searchMultipleSources - google-first strategy', () => {
    it('should return Google Shopping result when confident', async () => {
      mockGoogleShopping.mockResolvedValueOnce({
        bestPrice: 29.99,
        bestPriceSource: 'amazon',
        bestPriceUrl: 'https://amazon.com/product',
        confidence: 'high',
        reasoning: 'Found on Amazon',
        allResults: [],
      });

      const result = await searchMultipleSources('TestBrand', 'Product', { strategy: 'google-first' });

      expect(result.bestPrice).toBe(29.99);
      expect(result.bestPriceSource).toBe('amazon');
      expect(result.searchedSources).toContain('google-shopping');
      expect(mockAmazon).not.toHaveBeenCalled();
      expect(mockWalmart).not.toHaveBeenCalled();
    });

    it('should fallback to Amazon when Google Shopping fails', async () => {
      mockGoogleShopping.mockResolvedValueOnce({
        bestPrice: null,
        bestPriceSource: null,
        bestPriceUrl: null,
        confidence: 'low',
        reasoning: 'No results',
        allResults: [],
      });

      mockAmazon.mockResolvedValueOnce({
        price: 34.99,
        originalPrice: null,
        url: 'https://amazon.com/dp/B0TEST',
        asin: 'B0TEST',
        title: 'TestBrand Product',
        brand: 'TestBrand',
        isPrime: true,
        rating: 4.5,
        reviews: 100,
        allResults: [],
        confidence: 'high',
        reasoning: 'Amazon result',
      });

      const result = await searchMultipleSources('TestBrand', 'Product', { strategy: 'google-first' });

      expect(result.bestPrice).toBe(34.99);
      expect(result.bestPriceSource).toBe('amazon-direct');
      expect(result.searchedSources).toContain('google-shopping');
      expect(result.searchedSources).toContain('amazon-direct');
    });

    it('should fallback to Walmart when Google Shopping and Amazon fail', async () => {
      mockGoogleShopping.mockResolvedValueOnce({
        bestPrice: null,
        bestPriceSource: null,
        bestPriceUrl: null,
        confidence: 'low',
        reasoning: 'No results',
        allResults: [],
      });

      mockAmazon.mockResolvedValueOnce({
        price: null,
        originalPrice: null,
        url: null,
        asin: null,
        title: null,
        brand: null,
        isPrime: false,
        rating: null,
        reviews: null,
        allResults: [],
        confidence: 'low',
        reasoning: 'Not found',
      });

      mockWalmart.mockResolvedValueOnce({
        price: 27.99,
        originalPrice: null,
        url: 'https://walmart.com/ip/123',
        productId: '123',
        title: 'TestBrand Product',
        seller: 'Walmart.com',
        isTwoDayShipping: true,
        rating: 4.3,
        reviews: 50,
        allResults: [],
        confidence: 'medium',
        reasoning: 'Walmart result',
      });

      const result = await searchMultipleSources('TestBrand', 'Product', { strategy: 'google-first' });

      expect(result.bestPrice).toBe(27.99);
      expect(result.bestPriceSource).toBe('walmart-direct');
      expect(result.searchedSources).toContain('walmart-direct');
    });

    it('should return no results when all sources fail', async () => {
      mockGoogleShopping.mockResolvedValueOnce({
        bestPrice: null,
        bestPriceSource: null,
        bestPriceUrl: null,
        confidence: 'low',
        reasoning: 'No results',
        allResults: [],
      });

      mockAmazon.mockResolvedValueOnce({
        price: null,
        originalPrice: null,
        url: null,
        asin: null,
        title: null,
        brand: null,
        isPrime: false,
        rating: null,
        reviews: null,
        allResults: [],
        confidence: 'low',
        reasoning: 'Not found',
      });

      mockWalmart.mockResolvedValueOnce({
        price: null,
        originalPrice: null,
        url: null,
        productId: null,
        title: null,
        seller: null,
        isTwoDayShipping: false,
        rating: null,
        reviews: null,
        allResults: [],
        confidence: 'low',
        reasoning: 'Not found',
      });

      const result = await searchMultipleSources('UnknownBrand', 'Product', { strategy: 'google-first' });

      expect(result.bestPrice).toBeNull();
      expect(result.bestPriceSource).toBeNull();
      expect(result.confidence).toBe('low');
      expect(result.searchedSources).toHaveLength(3);
    });

    it('should respect searchAmazon=false option', async () => {
      mockGoogleShopping.mockResolvedValueOnce({
        bestPrice: null,
        bestPriceSource: null,
        bestPriceUrl: null,
        confidence: 'low',
        reasoning: 'No results',
        allResults: [],
      });

      mockWalmart.mockResolvedValueOnce({
        price: 24.99,
        originalPrice: null,
        url: 'https://walmart.com/ip/123',
        productId: '123',
        title: 'TestBrand Product',
        seller: 'Walmart.com',
        isTwoDayShipping: true,
        rating: 4.0,
        reviews: 30,
        allResults: [],
        confidence: 'medium',
        reasoning: 'Found',
      });

      const result = await searchMultipleSources('TestBrand', 'Product', { 
        strategy: 'google-first',
        searchAmazon: false,
      });

      expect(result.bestPrice).toBe(24.99);
      expect(mockAmazon).not.toHaveBeenCalled();
      expect(result.searchedSources).not.toContain('amazon-direct');
    });

    it('should respect searchWalmart=false option', async () => {
      mockGoogleShopping.mockResolvedValueOnce({
        bestPrice: null,
        bestPriceSource: null,
        bestPriceUrl: null,
        confidence: 'low',
        reasoning: 'No results',
        allResults: [],
      });

      mockAmazon.mockResolvedValueOnce({
        price: null,
        originalPrice: null,
        url: null,
        asin: null,
        title: null,
        brand: null,
        isPrime: false,
        rating: null,
        reviews: null,
        allResults: [],
        confidence: 'low',
        reasoning: 'Not found',
      });

      const result = await searchMultipleSources('TestBrand', 'Product', { 
        strategy: 'google-first',
        searchWalmart: false,
      });

      expect(result.bestPrice).toBeNull();
      expect(mockWalmart).not.toHaveBeenCalled();
      expect(result.searchedSources).not.toContain('walmart-direct');
    });
  });

  describe('searchMultipleSources - parallel strategy', () => {
    it('should search all sources in parallel', async () => {
      mockGoogleShopping.mockResolvedValueOnce({
        bestPrice: 29.99,
        bestPriceSource: 'target',
        bestPriceUrl: 'https://target.com/product',
        confidence: 'medium',
        reasoning: 'Found on Target',
        allResults: [],
      });

      mockAmazon.mockResolvedValueOnce({
        price: 27.99,
        originalPrice: null,
        url: 'https://amazon.com/dp/B0TEST',
        asin: 'B0TEST',
        title: 'TestBrand Product',
        brand: 'TestBrand',
        isPrime: true,
        rating: 4.8,
        reviews: 200,
        allResults: [],
        confidence: 'high',
        reasoning: 'Prime product',
      });

      mockWalmart.mockResolvedValueOnce({
        price: 31.99,
        originalPrice: null,
        url: 'https://walmart.com/ip/123',
        productId: '123',
        title: 'TestBrand Product',
        seller: 'Walmart.com',
        isTwoDayShipping: true,
        rating: 4.0,
        reviews: 50,
        allResults: [],
        confidence: 'medium',
        reasoning: 'Walmart result',
      });

      const result = await searchMultipleSources('TestBrand', 'Product', { strategy: 'parallel' });

      // Should pick highest confidence (Amazon with 'high')
      expect(result.bestPrice).toBe(27.99);
      expect(result.bestPriceSource).toBe('amazon-direct');
      expect(result.searchedSources).toHaveLength(3);
    });

    it('should prefer higher confidence over lower price', async () => {
      mockGoogleShopping.mockResolvedValueOnce({
        bestPrice: 19.99, // Cheapest but low confidence
        bestPriceSource: 'other',
        bestPriceUrl: 'https://sketchy-site.com/product',
        confidence: 'low',
        reasoning: 'Questionable source',
        allResults: [],
      });

      mockAmazon.mockResolvedValueOnce({
        price: 29.99,
        originalPrice: null,
        url: 'https://amazon.com/dp/B0TEST',
        asin: 'B0TEST',
        title: 'TestBrand Product',
        brand: 'TestBrand',
        isPrime: true,
        rating: 4.5,
        reviews: 100,
        allResults: [],
        confidence: 'high',
        reasoning: 'Trusted source',
      });

      mockWalmart.mockResolvedValueOnce({
        price: null,
        originalPrice: null,
        url: null,
        productId: null,
        title: null,
        seller: null,
        isTwoDayShipping: false,
        rating: null,
        reviews: null,
        allResults: [],
        confidence: 'low',
        reasoning: 'Not found',
      });

      const result = await searchMultipleSources('TestBrand', 'Product', { strategy: 'parallel' });

      // Should pick high-confidence Amazon over low-confidence cheaper source
      expect(result.bestPrice).toBe(29.99);
      expect(result.confidence).toBe('high');
    });
  });

  describe('searchMultipleSources - direct-only strategy', () => {
    it('should skip Google Shopping', async () => {
      mockAmazon.mockResolvedValueOnce({
        price: 29.99,
        originalPrice: null,
        url: 'https://amazon.com/dp/B0TEST',
        asin: 'B0TEST',
        title: 'TestBrand Product',
        brand: 'TestBrand',
        isPrime: true,
        rating: 4.5,
        reviews: 100,
        allResults: [],
        confidence: 'high',
        reasoning: 'Found',
      });

      mockWalmart.mockResolvedValueOnce({
        price: 27.99,
        originalPrice: null,
        url: 'https://walmart.com/ip/123',
        productId: '123',
        title: 'TestBrand Product',
        seller: 'Walmart.com',
        isTwoDayShipping: true,
        rating: 4.0,
        reviews: 50,
        allResults: [],
        confidence: 'medium',
        reasoning: 'Found',
      });

      const result = await searchMultipleSources('TestBrand', 'Product', { strategy: 'direct-only' });

      expect(result.bestPrice).toBe(29.99);
      expect(result.bestPriceSource).toBe('amazon-direct');
      expect(mockGoogleShopping).not.toHaveBeenCalled();
      expect(result.googleShoppingResult).toBeNull();
    });

    it('should prefer Amazon over Walmart', async () => {
      mockAmazon.mockResolvedValueOnce({
        price: 32.99,
        originalPrice: null,
        url: 'https://amazon.com/dp/B0TEST',
        asin: 'B0TEST',
        title: 'TestBrand Product',
        brand: 'TestBrand',
        isPrime: true,
        rating: 4.5,
        reviews: 100,
        allResults: [],
        confidence: 'medium',
        reasoning: 'Found',
      });

      mockWalmart.mockResolvedValueOnce({
        price: 27.99, // Cheaper than Amazon
        originalPrice: null,
        url: 'https://walmart.com/ip/123',
        productId: '123',
        title: 'TestBrand Product',
        seller: 'Walmart.com',
        isTwoDayShipping: true,
        rating: 4.0,
        reviews: 50,
        allResults: [],
        confidence: 'medium',
        reasoning: 'Found',
      });

      const result = await searchMultipleSources('TestBrand', 'Product', { strategy: 'direct-only' });

      // Should still prefer Amazon (same confidence, but Amazon checked first)
      expect(result.bestPrice).toBe(32.99);
      expect(result.bestPriceSource).toBe('amazon-direct');
    });

    it('should use Walmart when Amazon fails', async () => {
      mockAmazon.mockResolvedValueOnce({
        price: null,
        originalPrice: null,
        url: null,
        asin: null,
        title: null,
        brand: null,
        isPrime: false,
        rating: null,
        reviews: null,
        allResults: [],
        confidence: 'low',
        reasoning: 'Not found',
      });

      mockWalmart.mockResolvedValueOnce({
        price: 27.99,
        originalPrice: null,
        url: 'https://walmart.com/ip/123',
        productId: '123',
        title: 'TestBrand Product',
        seller: 'Walmart.com',
        isTwoDayShipping: true,
        rating: 4.0,
        reviews: 50,
        allResults: [],
        confidence: 'medium',
        reasoning: 'Found',
      });

      const result = await searchMultipleSources('TestBrand', 'Product', { strategy: 'direct-only' });

      expect(result.bestPrice).toBe(27.99);
      expect(result.bestPriceSource).toBe('walmart-direct');
    });
  });

  describe('getBestRetailPrice', () => {
    it('should return simplified result', async () => {
      mockGoogleShopping.mockResolvedValueOnce({
        bestPrice: 24.99,
        bestPriceSource: 'amazon',
        bestPriceUrl: 'https://amazon.com/product',
        confidence: 'high',
        reasoning: 'Found',
        allResults: [],
      });

      const result = await getBestRetailPrice('TestBrand', 'Product');

      expect(result.price).toBe(24.99);
      expect(result.source).toBe('amazon');
      expect(result.url).toBe('https://amazon.com/product');
      expect(result.confidence).toBe('high');
    });

    it('should return not-found when no price available', async () => {
      mockGoogleShopping.mockResolvedValueOnce({
        bestPrice: null,
        bestPriceSource: null,
        bestPriceUrl: null,
        confidence: 'low',
        reasoning: 'No results',
        allResults: [],
      });

      mockAmazon.mockResolvedValueOnce({
        price: null,
        originalPrice: null,
        url: null,
        asin: null,
        title: null,
        brand: null,
        isPrime: false,
        rating: null,
        reviews: null,
        allResults: [],
        confidence: 'low',
        reasoning: 'Not found',
      });

      mockWalmart.mockResolvedValueOnce({
        price: null,
        originalPrice: null,
        url: null,
        productId: null,
        title: null,
        seller: null,
        isTwoDayShipping: false,
        rating: null,
        reviews: null,
        allResults: [],
        confidence: 'low',
        reasoning: 'Not found',
      });

      const result = await getBestRetailPrice('UnknownBrand', 'Product');

      expect(result.price).toBeNull();
      expect(result.source).toBe('not-found');
    });
  });
});
