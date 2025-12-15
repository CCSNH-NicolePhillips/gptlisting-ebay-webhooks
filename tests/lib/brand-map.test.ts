describe('brand-map', () => {
  let mockFetch: jest.Mock;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    
    process.env.UPSTASH_REDIS_REST_URL = 'https://test-redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

    mockFetch = jest.fn();
    global.fetch = mockFetch as any;

    consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  describe('module initialization', () => {
    it('should warn if Upstash credentials missing', () => {
      delete process.env.UPSTASH_REDIS_REST_URL;
      jest.resetModules();
      require('../../src/lib/brand-map');
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('BRAND MAP DISABLED')
      );
    });

    it('should not warn if credentials present', () => {
      jest.resetModules();
      require('../../src/lib/brand-map');
      
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe('setBrandUrls', () => {
    it('should store brand URLs', async () => {
      const { setBrandUrls } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      });

      const urls = {
        brand: 'TestBrand',
        amazon: 'https://amazon.com/brand',
        walmart: 'https://walmart.com/brand',
      };

      await setBrandUrls('test-sig', urls);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/SET/brandmap%3Atest-sig/'),
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer test-token' },
        })
      );

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain(encodeURIComponent(JSON.stringify(urls)));
    });

    it('should return early if sig is empty', async () => {
      const { setBrandUrls } = require('../../src/lib/brand-map');

      await setBrandUrls('', { brand: 'Test' });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle fetch errors gracefully', async () => {
      const { setBrandUrls } = require('../../src/lib/brand-map');
      
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await setBrandUrls('test-sig', { brand: 'Test' });

      expect(consoleSpy).toHaveBeenCalledWith(
        'brand-map write failed',
        expect.any(Error)
      );
    });

    it('should handle HTTP errors', async () => {
      const { setBrandUrls } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      // Should catch and log error, not throw
      await setBrandUrls('test-sig', { brand: 'Test' });
      
      expect(consoleSpy).toHaveBeenCalledWith(
        'brand-map write failed',
        expect.any(Error)
      );
    });

    it('should store all optional fields', async () => {
      const { setBrandUrls } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      });

      const urls = {
        brand: 'TestBrand',
        amazon: 'https://amazon.com/brand',
        walmart: 'https://walmart.com/brand',
        requiresJs: true,
        lastChecked: 1234567890,
      };

      await setBrandUrls('test-sig', urls);

      const callUrl = mockFetch.mock.calls[0][0];
      const encodedData = encodeURIComponent(JSON.stringify(urls));
      expect(callUrl).toContain(encodedData);
    });

    it('should not call Redis when credentials missing', async () => {
      delete process.env.UPSTASH_REDIS_REST_URL;
      const { setBrandUrls } = require('../../src/lib/brand-map');

      await setBrandUrls('test-sig', { brand: 'Test' });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should URL-encode special characters in sig', async () => {
      const { setBrandUrls } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      });

      await setBrandUrls('test/sig:with@special', { brand: 'Test' });

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain('test%2Fsig%3Awith%40special');
    });
  });

  describe('getBrandUrls', () => {
    it('should retrieve brand URLs', async () => {
      const { getBrandUrls } = require('../../src/lib/brand-map');
      
      const urls = {
        brand: 'TestBrand',
        amazon: 'https://amazon.com/brand',
        walmart: 'https://walmart.com/brand',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(urls) }),
      });

      const result = await getBrandUrls('test-sig');

      expect(result).toEqual(urls);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/GET/brandmap%3Atest-sig'),
        expect.any(Object)
      );
    });

    it('should return null if sig is empty', async () => {
      const { getBrandUrls } = require('../../src/lib/brand-map');

      const result = await getBrandUrls('');

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return null if key not found', async () => {
      const { getBrandUrls } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      });

      const result = await getBrandUrls('missing-sig');

      expect(result).toBeNull();
    });

    it('should return null on invalid JSON', async () => {
      const { getBrandUrls } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'invalid json {' }),
      });

      const result = await getBrandUrls('test-sig');

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        'brand-map parse failed',
        expect.any(Error)
      );
    });

    it('should handle fetch errors gracefully', async () => {
      const { getBrandUrls } = require('../../src/lib/brand-map');
      
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await getBrandUrls('test-sig');

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        'brand-map read failed',
        expect.any(Error)
      );
    });

    it('should return null when credentials missing', async () => {
      delete process.env.UPSTASH_REDIS_REST_URL;
      const { getBrandUrls } = require('../../src/lib/brand-map');

      const result = await getBrandUrls('test-sig');

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle non-string result', async () => {
      const { getBrandUrls } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 12345 }),
      });

      const result = await getBrandUrls('test-sig');

      expect(result).toBeNull();
    });

    it('should handle empty string result', async () => {
      const { getBrandUrls } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: '' }),
      });

      const result = await getBrandUrls('test-sig');

      expect(result).toBeNull();
    });

    it('should retrieve all optional fields', async () => {
      const { getBrandUrls } = require('../../src/lib/brand-map');
      
      const urls = {
        brand: 'TestBrand',
        amazon: 'https://amazon.com/brand',
        walmart: 'https://walmart.com/brand',
        requiresJs: true,
        lastChecked: 1234567890,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(urls) }),
      });

      const result = await getBrandUrls('test-sig');

      expect(result).toEqual(urls);
    });
  });

  describe('setBrandMetadata', () => {
    it('should store brand metadata', async () => {
      const { setBrandMetadata } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      });

      const metadata = {
        defaultProductType: 'skincare',
        category: 'Beauty',
        notes: 'Premium brand',
      };

      await setBrandMetadata('TestBrand', metadata);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/SET/brandmeta%3Atestbrand/'),
        expect.any(Object)
      );

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain(encodeURIComponent(JSON.stringify(metadata)));
    });

    it('should normalize brand name to lowercase', async () => {
      const { setBrandMetadata } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      });

      await setBrandMetadata('TESTBRAND', { defaultProductType: 'test' });

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain('brandmeta%3Atestbrand');
    });

    it('should trim whitespace from brand name', async () => {
      const { setBrandMetadata } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      });

      await setBrandMetadata('  TestBrand  ', { defaultProductType: 'test' });

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain('brandmeta%3Atestbrand');
    });

    it('should return early if brandName is empty', async () => {
      const { setBrandMetadata } = require('../../src/lib/brand-map');

      await setBrandMetadata('', { defaultProductType: 'test' });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle fetch errors gracefully', async () => {
      const { setBrandMetadata } = require('../../src/lib/brand-map');
      
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await setBrandMetadata('TestBrand', { defaultProductType: 'test' });

      expect(consoleSpy).toHaveBeenCalledWith(
        'brand-metadata write failed',
        expect.any(Error)
      );
    });

    it('should store product patterns', async () => {
      const { setBrandMetadata } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      });

      const metadata = {
        defaultProductType: 'beauty',
        productPatterns: [
          { keywords: ['serum', 'cream'], productType: 'skincare beauty' },
          { keywords: ['lipstick', 'gloss'], productType: 'makeup beauty' },
        ],
      };

      await setBrandMetadata('TestBrand', metadata);

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain(encodeURIComponent(JSON.stringify(metadata)));
    });

    it('should not call Redis when credentials missing', async () => {
      delete process.env.UPSTASH_REDIS_REST_URL;
      const { setBrandMetadata } = require('../../src/lib/brand-map');

      await setBrandMetadata('TestBrand', { defaultProductType: 'test' });

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('getBrandMetadata', () => {
    it('should retrieve brand metadata', async () => {
      const { getBrandMetadata } = require('../../src/lib/brand-map');
      
      const metadata = {
        defaultProductType: 'skincare',
        category: 'Beauty',
        notes: 'Premium brand',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(metadata) }),
      });

      const result = await getBrandMetadata('TestBrand');

      expect(result).toEqual(metadata);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/GET/brandmeta%3Atestbrand'),
        expect.any(Object)
      );
    });

    it('should normalize brand name to lowercase', async () => {
      const { getBrandMetadata } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify({ defaultProductType: 'test' }) }),
      });

      await getBrandMetadata('TESTBRAND');

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain('brandmeta%3Atestbrand');
    });

    it('should trim whitespace from brand name', async () => {
      const { getBrandMetadata } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify({ defaultProductType: 'test' }) }),
      });

      await getBrandMetadata('  TestBrand  ');

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain('brandmeta%3Atestbrand');
    });

    it('should return null if brandName is empty', async () => {
      const { getBrandMetadata } = require('../../src/lib/brand-map');

      const result = await getBrandMetadata('');

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return null if key not found', async () => {
      const { getBrandMetadata } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      });

      const result = await getBrandMetadata('MissingBrand');

      expect(result).toBeNull();
    });

    it('should return null on invalid JSON', async () => {
      const { getBrandMetadata } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'invalid json {' }),
      });

      const result = await getBrandMetadata('TestBrand');

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        'brand-metadata parse failed',
        expect.any(Error)
      );
    });

    it('should handle fetch errors gracefully', async () => {
      const { getBrandMetadata } = require('../../src/lib/brand-map');
      
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await getBrandMetadata('TestBrand');

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        'brand-metadata read failed',
        expect.any(Error)
      );
    });

    it('should return null when credentials missing', async () => {
      delete process.env.UPSTASH_REDIS_REST_URL;
      const { getBrandMetadata } = require('../../src/lib/brand-map');

      const result = await getBrandMetadata('TestBrand');

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle non-string result', async () => {
      const { getBrandMetadata } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 12345 }),
      });

      const result = await getBrandMetadata('TestBrand');

      expect(result).toBeNull();
    });

    it('should handle empty string result', async () => {
      const { getBrandMetadata } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: '' }),
      });

      const result = await getBrandMetadata('TestBrand');

      expect(result).toBeNull();
    });

    it('should retrieve product patterns', async () => {
      const { getBrandMetadata } = require('../../src/lib/brand-map');
      
      const metadata = {
        defaultProductType: 'beauty',
        productPatterns: [
          { keywords: ['serum', 'cream'], productType: 'skincare beauty' },
          { keywords: ['lipstick', 'gloss'], productType: 'makeup beauty' },
        ],
        category: 'Beauty & Personal Care',
        notes: 'High-end cosmetics',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(metadata) }),
      });

      const result = await getBrandMetadata('TestBrand');

      expect(result).toEqual(metadata);
    });

    it('should handle HTTP errors', async () => {
      const { getBrandMetadata } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      // Should catch and log error, return null
      const result = await getBrandMetadata('TestBrand');
      
      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        'brand-metadata read failed',
        expect.any(Error)
      );
    });
  });

  describe('trailing slash handling', () => {
    it('should strip trailing slash from BASE URL', async () => {
      process.env.UPSTASH_REDIS_REST_URL = 'https://test-redis.upstash.io/';
      const { getBrandUrls } = require('../../src/lib/brand-map');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      });

      await getBrandUrls('test-sig');

      const callUrl = mockFetch.mock.calls[0][0];
      const pathPart = callUrl.replace('https://', '');
      expect(pathPart).not.toContain('//');
    });
  });
});
