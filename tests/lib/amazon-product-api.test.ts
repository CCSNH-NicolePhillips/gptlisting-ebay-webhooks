/**
 * Tests for amazon-product-api.ts
 * Amazon Product Advertising API integration
 */

// Set up env vars before imports
process.env.AMAZON_ACCESS_KEY = 'test-access-key';
process.env.AMAZON_SECRET_KEY = 'test-secret-key';
process.env.AMAZON_PARTNER_TAG = 'test-tag-20';
process.env.AMAZON_REGION = 'us-east-1';

import { searchAmazonProduct } from '../../src/lib/amazon-product-api.js';

// Mock global fetch
global.fetch = jest.fn();

// Mock aws-sign-v4
jest.mock('../../src/lib/aws-sign-v4.js', () => ({
  signAwsRequest: jest.fn((config, request) => ({
    url: 'https://webservices.amazon.com/paapi5/searchitems',
    headers: {
      'Content-Type': 'application/json',
      'X-Amz-Date': '20251215T120000Z',
      Authorization: 'AWS4-HMAC-SHA256 Credential=test/20251215/us-east-1/ProductAdvertisingAPI/aws4_request'
    },
    body: request.body
  }))
}));

describe('amazon-product-api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockReset();
  });

  describe('searchAmazonProduct - Basic functionality', () => {
    it('should search with title and brand', async () => {
      const mockResponse = {
        SearchResult: {
          Items: [{
            ASIN: 'B08N5WRWNW',
            ItemInfo: {
              Title: { DisplayValue: 'Apple AirPods Pro' },
              ByLineInfo: { Brand: { DisplayValue: 'Apple' } }
            },
            Offers: {
              Listings: [{
                Price: { Amount: 249.99, Currency: 'USD' }
              }]
            },
            DetailPageURL: 'https://amazon.com/dp/B08N5WRWNW',
            BrowseNodeInfo: {
              BrowseNodes: [{
                DisplayName: 'Electronics',
                Ancestor: {
                  DisplayName: 'Categories',
                  Ancestor: null
                }
              }]
            }
          }]
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      const result = await searchAmazonProduct({
        title: 'AirPods Pro',
        brand: 'Apple'
      });

      expect(result).toEqual({
        asin: 'B08N5WRWNW',
        title: 'Apple AirPods Pro',
        price: 249.99,
        currency: 'USD',
        url: 'https://amazon.com/dp/B08N5WRWNW',
        categories: ['Electronics', 'Categories']
      });

      // Verify fetch was called with signed request
      expect(fetch).toHaveBeenCalledWith(
        'https://webservices.amazon.com/paapi5/searchitems',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: expect.stringContaining('AWS4-HMAC-SHA256')
          })
        })
      );
    });

    it('should search with UPC', async () => {
      const mockResponse = {
        SearchResult: {
          Items: [{
            ASIN: 'B0CHWRXH8B',
            ItemInfo: {
              Title: { DisplayValue: 'Product by UPC' }
            },
            Offers: { Listings: [{ Price: { Amount: 29.99, Currency: 'USD' } }] },
            DetailPageURL: 'https://amazon.com/dp/B0CHWRXH8B',
            BrowseNodeInfo: { BrowseNodes: [] }
          }]
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      const result = await searchAmazonProduct({
        title: 'Some Product',
        upc: '123456789012'
      });

      expect(result?.asin).toBe('B0CHWRXH8B');
      
      // Verify UPC was included in request body
      const requestBody = (fetch as jest.Mock).mock.calls[0][1].body;
      expect(requestBody).toContain('123456789012');
    });

    it('should use keywordsOverride when provided', async () => {
      const mockResponse = {
        SearchResult: {
          Items: [{
            ASIN: 'B123456789',
            ItemInfo: { Title: { DisplayValue: 'Override Product' } },
            Offers: { Listings: [{ Price: { Amount: 99.99, Currency: 'USD' } }] },
            DetailPageURL: 'https://amazon.com/dp/B123456789',
            BrowseNodeInfo: { BrowseNodes: [] }
          }]
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      await searchAmazonProduct({
        title: 'Original Title',
        brand: 'Original Brand',
        keywordsOverride: 'custom search terms'
      });

      const requestBody = (fetch as jest.Mock).mock.calls[0][1].body;
      const bodyObj = JSON.parse(requestBody);
      
      expect(bodyObj.Keywords).toBe('custom search terms');
      expect(requestBody).not.toContain('Original Title');
    });

    it('should handle multiple browse node ancestors', async () => {
      const mockResponse = {
        SearchResult: {
          Items: [{
            ASIN: 'B111111111',
            ItemInfo: { Title: { DisplayValue: 'Nested Category Product' } },
            Offers: { Listings: [{ Price: { Amount: 19.99, Currency: 'USD' } }] },
            DetailPageURL: 'https://amazon.com/dp/B111111111',
            BrowseNodeInfo: {
              BrowseNodes: [{
                DisplayName: 'Smartphones',
                Ancestor: {
                  DisplayName: 'Cell Phones',
                  Ancestor: {
                    DisplayName: 'Electronics',
                    Ancestor: {
                      DisplayName: 'All',
                      Ancestor: null
                    }
                  }
                }
              }]
            }
          }]
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      const result = await searchAmazonProduct({
        title: 'iPhone'
      });

      expect(result?.categories).toEqual(['Smartphones', 'Cell Phones', 'Electronics', 'All']);
    });

    it('should deduplicate categories', async () => {
      const mockResponse = {
        SearchResult: {
          Items: [{
            ASIN: 'B222222222',
            ItemInfo: { Title: { DisplayValue: 'Duplicate Category Test' } },
            Offers: { Listings: [{ Price: { Amount: 50.00, Currency: 'USD' } }] },
            DetailPageURL: 'https://amazon.com/dp/B222222222',
            BrowseNodeInfo: {
              BrowseNodes: [
                {
                  DisplayName: 'Electronics',
                  Ancestor: null
                },
                {
                  DisplayName: 'Gadgets',
                  Ancestor: {
                    DisplayName: 'Electronics',
                    Ancestor: null
                  }
                }
              ]
            }
          }]
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      const result = await searchAmazonProduct({
        title: 'Test Product'
      });

      // Should have unique categories only
      expect(result?.categories).toEqual(['Electronics', 'Gadgets']);
      expect(result?.categories.length).toBe(2);
    });
  });

  describe('searchAmazonProduct - Price handling', () => {
    it('should handle missing price', async () => {
      const mockResponse = {
        SearchResult: {
          Items: [{
            ASIN: 'B333333333',
            ItemInfo: { Title: { DisplayValue: 'No Price Product' } },
            Offers: { Listings: [] },
            DetailPageURL: 'https://amazon.com/dp/B333333333',
            BrowseNodeInfo: { BrowseNodes: [] }
          }]
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      const result = await searchAmazonProduct({
        title: 'No Price'
      });

      expect(result?.price).toBeNull();
      expect(result?.currency).toBeNull();
    });

    it('should fallback to SavingBasis for price', async () => {
      const mockResponse = {
        SearchResult: {
          Items: [{
            ASIN: 'B444444444',
            ItemInfo: { Title: { DisplayValue: 'Saving Basis Product' } },
            Offers: {
              Listings: [{
                SavingBasis: { Amount: 149.99, Currency: 'USD' }
              }]
            },
            DetailPageURL: 'https://amazon.com/dp/B444444444',
            BrowseNodeInfo: { BrowseNodes: [] }
          }]
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      const result = await searchAmazonProduct({
        title: 'Discount Item'
      });

      expect(result?.price).toBe(149.99);
      expect(result?.currency).toBe('USD');
    });

    it('should handle non-numeric price', async () => {
      const mockResponse = {
        SearchResult: {
          Items: [{
            ASIN: 'B555555555',
            ItemInfo: { Title: { DisplayValue: 'Invalid Price' } },
            Offers: {
              Listings: [{
                Price: { Amount: 'unavailable', Currency: 'USD' }
              }]
            },
            DetailPageURL: 'https://amazon.com/dp/B555555555',
            BrowseNodeInfo: { BrowseNodes: [] }
          }]
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      const result = await searchAmazonProduct({
        title: 'Bad Price'
      });

      expect(result?.price).toBeNull();
    });
  });

  describe('searchAmazonProduct - Error handling', () => {
    it('should return null on network error', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network timeout'));

      const result = await searchAmazonProduct({
        title: 'Network Error Test'
      });

      expect(result).toBeNull();
    });

    it('should return null on non-200 response', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad Request'
      } as any);

      const result = await searchAmazonProduct({
        title: '400 Error Test'
      });

      expect(result).toBeNull();
    });

    it('should return null on 503 service unavailable', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable'
      } as any);

      const result = await searchAmazonProduct({
        title: '503 Error Test'
      });

      expect(result).toBeNull();
    });

    it('should return null on invalid JSON response', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => 'Not valid JSON{{'
      } as any);

      const result = await searchAmazonProduct({
        title: 'Invalid JSON Test'
      });

      expect(result).toBeNull();
    });

    it('should return null when no items found', async () => {
      const mockResponse = {
        SearchResult: {
          Items: []
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      const result = await searchAmazonProduct({
        title: 'No Results'
      });

      expect(result).toBeNull();
    });

    it('should return null when SearchResult is missing', async () => {
      const mockResponse = {
        Error: {
          Code: 'InvalidParameterValue',
          Message: 'Invalid Keywords'
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      const result = await searchAmazonProduct({
        title: 'Error Response'
      });

      expect(result).toBeNull();
    });
  });

  describe('searchAmazonProduct - Title handling', () => {
    it('should use DisplayValue title if available', async () => {
      const mockResponse = {
        SearchResult: {
          Items: [{
            ASIN: 'B666666666',
            ItemInfo: {
              Title: {
                DisplayValue: 'Amazon Display Title',
                Display: 'Alternate Display'
              }
            },
            Offers: { Listings: [{ Price: { Amount: 10.00, Currency: 'USD' } }] },
            DetailPageURL: 'https://amazon.com/dp/B666666666',
            BrowseNodeInfo: { BrowseNodes: [] }
          }]
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      const result = await searchAmazonProduct({
        title: 'Search Title'
      });

      expect(result?.title).toBe('Amazon Display Title');
    });

    it('should fallback to Display title if DisplayValue missing', async () => {
      const mockResponse = {
        SearchResult: {
          Items: [{
            ASIN: 'B777777777',
            ItemInfo: {
              Title: {
                Display: 'Fallback Display Title'
              }
            },
            Offers: { Listings: [{ Price: { Amount: 20.00, Currency: 'USD' } }] },
            DetailPageURL: 'https://amazon.com/dp/B777777777',
            BrowseNodeInfo: { BrowseNodes: [] }
          }]
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      const result = await searchAmazonProduct({
        title: 'Original Search Title'
      });

      expect(result?.title).toBe('Fallback Display Title');
    });

    it('should use input title if no Amazon title available', async () => {
      const mockResponse = {
        SearchResult: {
          Items: [{
            ASIN: 'B888888888',
            ItemInfo: {},
            Offers: { Listings: [{ Price: { Amount: 30.00, Currency: 'USD' } }] },
            DetailPageURL: 'https://amazon.com/dp/B888888888',
            BrowseNodeInfo: { BrowseNodes: [] }
          }]
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      const result = await searchAmazonProduct({
        title: 'User Input Title'
      });

      expect(result?.title).toBe('User Input Title');
    });
  });

  describe('searchAmazonProduct - Request body structure', () => {
    it('should include all required PA-API fields', async () => {
      const mockResponse = {
        SearchResult: {
          Items: [{
            ASIN: 'B999999999',
            ItemInfo: { Title: { DisplayValue: 'Test' } },
            Offers: { Listings: [] },
            DetailPageURL: 'https://amazon.com/dp/B999999999',
            BrowseNodeInfo: { BrowseNodes: [] }
          }]
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      await searchAmazonProduct({
        title: 'Test Product',
        brand: 'Test Brand'
      });

      const requestBody = (fetch as jest.Mock).mock.calls[0][1].body;
      const bodyObj = JSON.parse(requestBody);

      expect(bodyObj).toHaveProperty('Keywords');
      expect(bodyObj.Keywords).toBe('Test Brand Test Product');
      expect(bodyObj.SearchIndex).toBe('All');
      expect(bodyObj.PartnerTag).toBeTruthy(); // Uses actual config value
      expect(bodyObj.PartnerType).toBe('Associates');
      expect(bodyObj.Marketplace).toBe('www.amazon.com');
      expect(bodyObj.Resources).toContain('ItemInfo.Title');
      expect(bodyObj.Resources).toContain('Offers.Listings.Price');
      expect(bodyObj.Resources).toContain('BrowseNodeInfo.BrowseNodes');
    });

    it('should build Keywords from UPC, brand, and title', async () => {
      const mockResponse = {
        SearchResult: {
          Items: [{
            ASIN: 'BAAAAAAAAA',
            ItemInfo: { Title: { DisplayValue: 'Combined Keywords Test' } },
            Offers: { Listings: [] },
            DetailPageURL: 'https://amazon.com/dp/BAAAAAAAAA',
            BrowseNodeInfo: { BrowseNodes: [] }
          }]
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      await searchAmazonProduct({
        title: 'Widget Pro',
        brand: 'WidgetCorp',
        upc: '999888777666'
      });

      const requestBody = (fetch as jest.Mock).mock.calls[0][1].body;
      const bodyObj = JSON.parse(requestBody);

      expect(bodyObj.Keywords).toContain('999888777666');
      expect(bodyObj.Keywords).toContain('WidgetCorp');
      expect(bodyObj.Keywords).toContain('Widget Pro');
    });

    it('should handle empty Keywords gracefully', async () => {
      const mockResponse = {
        SearchResult: { Items: [] }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      const result = await searchAmazonProduct({
        title: ''
      });

      expect(result).toBeNull();
      
      const requestBody = (fetch as jest.Mock).mock.calls[0][1].body;
      const bodyObj = JSON.parse(requestBody);
      expect(bodyObj.Keywords).toBe('');
    });
  });

  describe('searchAmazonProduct - URL handling', () => {
    it('should return DetailPageURL when available', async () => {
      const mockResponse = {
        SearchResult: {
          Items: [{
            ASIN: 'BBBBBBBBBBB',
            ItemInfo: { Title: { DisplayValue: 'URL Test' } },
            Offers: { Listings: [] },
            DetailPageURL: 'https://www.amazon.com/dp/BBBBBBBBBBB?tag=test',
            BrowseNodeInfo: { BrowseNodes: [] }
          }]
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      const result = await searchAmazonProduct({
        title: 'URL Product'
      });

      expect(result?.url).toBe('https://www.amazon.com/dp/BBBBBBBBBBB?tag=test');
    });

    it('should return null URL when not provided', async () => {
      const mockResponse = {
        SearchResult: {
          Items: [{
            ASIN: 'BCCCCCCCCCCC',
            ItemInfo: { Title: { DisplayValue: 'No URL' } },
            Offers: { Listings: [] },
            BrowseNodeInfo: { BrowseNodes: [] }
          }]
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockResponse)
      } as any);

      const result = await searchAmazonProduct({
        title: 'No URL Product'
      });

      expect(result?.url).toBeNull();
    });
  });
});
