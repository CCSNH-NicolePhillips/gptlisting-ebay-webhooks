/**
 * Tests for search.ts
 * Tests Brave Search API integration for brand site discovery
 */

// Mock dependencies
jest.mock('../../src/lib/price-quota.js', () => ({
  canUseBrave: jest.fn(),
  incBrave: jest.fn(),
}));

describe('search', () => {
  let braveFirstUrl: any;
  let braveFirstUrlForBrandSite: any;
  let mockCanUseBrave: jest.Mock;
  let mockIncBrave: jest.Mock;
  let originalFetch: typeof global.fetch;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    
    // Setup mocks
    mockCanUseBrave = require('../../src/lib/price-quota.js').canUseBrave;
    mockIncBrave = require('../../src/lib/price-quota.js').incBrave;
    
    mockCanUseBrave.mockResolvedValue(true);
    mockIncBrave.mockResolvedValue(undefined);
    
    // Mock fetch
    originalFetch = global.fetch;
    mockFetch = jest.fn();
    global.fetch = mockFetch as any;
    
    // Set API key
    process.env.BRAVE_API_KEY = 'test-api-key';
    
    // Load module
    const searchModule = require('../../src/lib/search');
    braveFirstUrl = searchModule.braveFirstUrl;
    braveFirstUrlForBrandSite = searchModule.braveFirstUrlForBrandSite;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.BRAVE_API_KEY;
  });

  describe('braveFirstUrl', () => {
    describe('Basic functionality', () => {
      it('should return first URL from search results', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            web: {
              results: [
                { url: 'https://example.com/page1' },
                { url: 'https://example.com/page2' },
              ],
            },
          }),
        });

        const result = await braveFirstUrl('test query');

        expect(result).toBe('https://example.com/page1');
        expect(mockIncBrave).toHaveBeenCalled();
      });

      it('should include site parameter in query', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [{ url: 'https://example.com' }] } }),
        });

        await braveFirstUrl('test query', 'example.com');

        const callUrl = mockFetch.mock.calls[0][0];
        expect(callUrl).toContain('test+query+site%3Aexample.com');
      });

      it('should return null if no API key', async () => {
        delete process.env.BRAVE_API_KEY;

        const result = await braveFirstUrl('test query');

        expect(result).toBeNull();
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('should return null if quota exceeded', async () => {
        mockCanUseBrave.mockResolvedValue(false);

        const result = await braveFirstUrl('test query');

        expect(result).toBeNull();
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('should return null if no results', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [] } }),
        });

        const result = await braveFirstUrl('test query');

        expect(result).toBeNull();
      });

      it('should handle missing web field', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({}),
        });

        const result = await braveFirstUrl('test query');

        expect(result).toBeNull();
      });

      it('should handle missing results field', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ web: {} }),
        });

        const result = await braveFirstUrl('test query');

        expect(result).toBeNull();
      });
    });

    describe('Rate limiting and retries', () => {
      it('should retry on 429 rate limit', async () => {
        mockFetch
          .mockResolvedValueOnce({
            ok: false,
            status: 429,
            headers: new Map([['Retry-After', '1']]),
          } as any)
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ web: { results: [{ url: 'https://example.com' }] } }),
          });

        const result = await braveFirstUrl('test query');

        expect(result).toBe('https://example.com');
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it('should respect Retry-After header in seconds', async () => {
        const startTime = Date.now();
        
        mockFetch
          .mockResolvedValueOnce({
            ok: false,
            status: 429,
            headers: new Map([['Retry-After', '0']]),
          } as any)
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ web: { results: [{ url: 'https://example.com' }] } }),
          });

        await braveFirstUrl('test query');

        const elapsed = Date.now() - startTime;
        expect(elapsed).toBeLessThan(500); // Should not wait long for 0 seconds
      });

      it('should handle Retry-After as HTTP date', async () => {
        const futureDate = new Date(Date.now() + 100);
        
        mockFetch
          .mockResolvedValueOnce({
            ok: false,
            status: 429,
            headers: new Map([['Retry-After', futureDate.toUTCString()]]),
          } as any)
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ web: { results: [{ url: 'https://example.com' }] } }),
          });

        await braveFirstUrl('test query');

        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it('should use exponential backoff without Retry-After', async () => {
        mockFetch
          .mockResolvedValueOnce({
            ok: false,
            status: 429,
            headers: new Map(),
          } as any)
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ web: { results: [{ url: 'https://example.com' }] } }),
          });

        await braveFirstUrl('test query');

        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it('should cap retry delay at 10 seconds', async () => {
        mockFetch
          .mockResolvedValueOnce({
            ok: false,
            status: 429,
            headers: new Map([['Retry-After', '30']]), // 30 seconds
          } as any)
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ web: { results: [{ url: 'https://example.com' }] } }),
          });

        const startTime = Date.now();
        await braveFirstUrl('test query');
        const elapsed = Date.now() - startTime;

        // Should cap at 10 seconds, not wait full 30
        expect(elapsed).toBeLessThan(11000);
      }, 15000);

      it('should give up after max retries on 429', async () => {
        mockFetch.mockResolvedValue({
          ok: false,
          status: 429,
          headers: new Map([['Retry-After', '0']]),
        } as any);

        const result = await braveFirstUrl('test query');

        expect(result).toBeNull();
        expect(mockFetch).toHaveBeenCalledTimes(3); // max retries
      });

      it('should retry on network errors', async () => {
        mockFetch
          .mockRejectedValueOnce(new Error('Network error'))
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ web: { results: [{ url: 'https://example.com' }] } }),
          });

        const result = await braveFirstUrl('test query');

        expect(result).toBe('https://example.com');
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it('should give up after max retries on network errors', async () => {
        mockFetch.mockRejectedValue(new Error('Network error'));

        const result = await braveFirstUrl('test query');

        expect(result).toBeNull();
        expect(mockFetch).toHaveBeenCalledTimes(3);
      });
    });

    describe('Error handling', () => {
      it('should return null on non-200 status', async () => {
        mockFetch.mockResolvedValue({
          ok: false,
          status: 500,
        });

        const result = await braveFirstUrl('test query');

        expect(result).toBeNull();
      });

      it('should return null on fetch exception', async () => {
        mockFetch.mockRejectedValue(new Error('Fetch failed'));

        const result = await braveFirstUrl('test query');

        expect(result).toBeNull();
      });

      it('should handle malformed JSON', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => { throw new Error('Invalid JSON'); },
        });

        const result = await braveFirstUrl('test query');

        expect(result).toBeNull();
      });

      it('should handle null results array', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: null } }),
        });

        const result = await braveFirstUrl('test query');

        expect(result).toBeNull();
      });

      it('should handle results with missing url field', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [{}, { title: 'No URL' }] } }),
        });

        const result = await braveFirstUrl('test query');

        expect(result).toBeNull();
      });

      it('should handle results with empty url', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [{ url: '' }, { url: 'https://example.com' }] } }),
        });

        const result = await braveFirstUrl('test query');

        expect(result).toBe('https://example.com');
      });
    });
  });

  describe('braveFirstUrlForBrandSite', () => {
    describe('Basic functionality', () => {
      it('should find brand site URL', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            web: {
              results: [
                { url: 'https://brand-official.com/product' },
              ],
            },
          }),
        });

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBe('https://brand-official.com/product');
        expect(mockIncBrave).toHaveBeenCalled();
      });

      it('should use site-specific search with known brand domain', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [{ url: 'https://prequelskin.com/product' }] } }),
        });

        await braveFirstUrlForBrandSite('prequel', 'Test Product');

        const callUrl = mockFetch.mock.calls[0][0];
        expect(callUrl).toContain('site%3Aprequelskin.com');
      });

      it('should use provided brand domain', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [{ url: 'https://custom.com/product' }] } }),
        });

        await braveFirstUrlForBrandSite('TestBrand', 'TestProduct', 'custom.com');

        const callUrl = mockFetch.mock.calls[0][0];
        expect(callUrl).toContain('site%3Acustom.com');
      });

      it('should use generic query without brand domain', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [{ url: 'https://unknownbrand.com' }] } }),
        });

        await braveFirstUrlForBrandSite('UnknownBrand', 'TestProduct');

        const callUrl = mockFetch.mock.calls[0][0];
        expect(callUrl).toContain('official+site');
      });

      it('should return null if no API key', async () => {
        delete process.env.BRAVE_API_KEY;

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBeNull();
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('should return null if quota exceeded', async () => {
        mockCanUseBrave.mockResolvedValue(false);

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBeNull();
        expect(mockFetch).not.toHaveBeenCalled();
      });
    });

    describe('Retailer filtering', () => {
      it('should skip Amazon results', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            web: {
              results: [
                { url: 'https://amazon.com/product' },
                { url: 'https://brand-site.com/product' },
              ],
            },
          }),
        });

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBe('https://brand-site.com/product');
      });

      it('should skip Walmart results', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            web: {
              results: [
                { url: 'https://walmart.com/product' },
                { url: 'https://brand-site.com/product' },
              ],
            },
          }),
        });

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBe('https://brand-site.com/product');
      });

      it('should skip eBay results', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            web: {
              results: [
                { url: 'https://ebay.com/itm/12345' },
                { url: 'https://brand-site.com/product' },
              ],
            },
          }),
        });

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBe('https://brand-site.com/product');
      });

      it('should skip Target results', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            web: {
              results: [
                { url: 'https://target.com/p/product' },
                { url: 'https://brand-site.com/product' },
              ],
            },
          }),
        });

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBe('https://brand-site.com/product');
      });

      it('should skip multiple retailers', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            web: {
              results: [
                { url: 'https://amazon.com/product' },
                { url: 'https://walmart.com/product' },
                { url: 'https://bestbuy.com/product' },
                { url: 'https://brand-site.com/product' },
              ],
            },
          }),
        });

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBe('https://brand-site.com/product');
      });
    });

    describe('Excluded domains filtering', () => {
      it('should skip incidecoder.com', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            web: {
              results: [
                { url: 'https://incidecoder.com/products/test' },
                { url: 'https://brand-site.com/product' },
              ],
            },
          }),
        });

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBe('https://brand-site.com/product');
      });

      it('should skip Ulta and Sephora', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            web: {
              results: [
                { url: 'https://ulta.com/product' },
                { url: 'https://sephora.com/product' },
                { url: 'https://brand-site.com/product' },
              ],
            },
          }),
        });

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBe('https://brand-site.com/product');
      });

      it('should return null if only retailers/excluded sites found', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            web: {
              results: [
                { url: 'https://amazon.com/product' },
                { url: 'https://ulta.com/product' },
                { url: 'https://incidecoder.com/product' },
              ],
            },
          }),
        });

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBeNull();
      });
    });

    describe('Rate limiting and retries', () => {
      it('should retry on 429 rate limit', async () => {
        mockFetch
          .mockResolvedValueOnce({
            ok: false,
            status: 429,
            headers: new Map([['Retry-After', '1']]),
          } as any)
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ web: { results: [{ url: 'https://brand-site.com' }] } }),
          });

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBe('https://brand-site.com');
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it('should give up after max retries', async () => {
        mockFetch.mockResolvedValue({
          ok: false,
          status: 429,
          headers: new Map([['Retry-After', '0']]),
        } as any);

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBeNull();
        expect(mockFetch).toHaveBeenCalledTimes(3);
      });

      it('should retry on network errors', async () => {
        mockFetch
          .mockRejectedValueOnce(new Error('Network error'))
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ web: { results: [{ url: 'https://brand-site.com' }] } }),
          });

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBe('https://brand-site.com');
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });
    });

    describe('Error handling', () => {
      it('should return null on non-200 status', async () => {
        mockFetch.mockResolvedValue({
          ok: false,
          status: 500,
        });

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBeNull();
      });

      it('should handle empty results', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [] } }),
        });

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBeNull();
      });

      it('should handle missing web field', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({}),
        });

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBeNull();
      });

      it('should handle results with missing url', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [{ title: 'No URL' }] } }),
        });

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBeNull();
      });

      it('should handle results with non-string url', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [{ url: 123 }, { url: 'https://brand-site.com' }] } }),
        });

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBe('https://brand-site.com');
      });

      it('should handle fetch exception', async () => {
        mockFetch.mockRejectedValue(new Error('Fetch failed'));

        const result = await braveFirstUrlForBrandSite('TestBrand', 'TestProduct');

        expect(result).toBeNull();
      });
    });

    describe('Known brand mappings', () => {
      it('should use prequel brand mapping', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [{ url: 'https://prequelskin.com/product' }] } }),
        });

        await braveFirstUrlForBrandSite('prequel', 'Glow Serum');

        const callUrl = mockFetch.mock.calls[0][0];
        expect(callUrl).toContain('prequelskin.com');
      });

      it('should use maude brand mapping', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [{ url: 'https://getmaude.com/product' }] } }),
        });

        await braveFirstUrlForBrandSite('maude', 'Product');

        const callUrl = mockFetch.mock.calls[0][0];
        expect(callUrl).toContain('getmaude.com');
      });

      it('should handle case-insensitive brand lookup', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [{ url: 'https://prequelskin.com/product' }] } }),
        });

        await braveFirstUrlForBrandSite('PREQUEL', 'Product');

        const callUrl = mockFetch.mock.calls[0][0];
        expect(callUrl).toContain('prequelskin.com');
      });
    });
  });
});
