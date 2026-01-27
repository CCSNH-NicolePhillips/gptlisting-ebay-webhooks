import {
  getCampaigns,
  createCampaign,
  getAds,
  createAds,
  updateAdRate,
  deleteAd,
  promoteOfferOnce,
  promoteSingleListing,
  promoteSkusForUser,
  EbayTokenCache,
} from '../../src/lib/ebay-promote';

// Mock dependencies
jest.mock('../../src/lib/ebay-auth.js', () => ({
  getEbayAccessToken: jest.fn(),
}));

jest.mock('../../src/lib/redis-store.js', () => ({
  tokensStore: jest.fn(() => ({
    get: jest.fn(),
    put: jest.fn(),
  })),
}));

jest.mock('../../src/lib/_auth.js', () => ({
  userScopedKey: jest.fn((userId: string, filename: string) => `${userId}/${filename}`),
}));

jest.mock('../../src/lib/_common.js', () => ({
  accessTokenFromRefresh: jest.fn(),
  tokenHosts: jest.fn(() => ({ apiHost: 'https://api.sandbox.ebay.com' })),
}));

jest.mock('../../src/config.js', () => ({
  cfg: {
    ebay: {
      defaultMarketplaceId: 'EBAY_US',
      promotedCampaignId: null,
    },
  },
}));

// Mock global fetch
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

import { getEbayAccessToken } from '../../src/lib/ebay-auth.js';
import { tokensStore } from '../../src/lib/redis-store.js';
import { accessTokenFromRefresh } from '../../src/lib/_common.js';

describe('ebay-promote', () => {
  const mockTokenCache: EbayTokenCache = {
    get: jest.fn(),
    set: jest.fn(),
  };

  // Helper to create mock fetch response that works with both .json() and .text()
  const mockFetchResponse = (data: any, options: { ok?: boolean; status?: number; headers?: any } = {}) => {
    const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
    return {
      ok: options.ok ?? true,
      status: options.status ?? 200,
      headers: options.headers || { get: () => null },
      json: async () => (typeof data === 'string' ? JSON.parse(data) : data),
      text: async () => jsonStr,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockClear();
  });

  describe('getCampaigns', () => {
    it('should fetch campaigns successfully', async () => {
      const mockAccessToken = 'test-access-token';
      const mockApiHost = 'https://api.sandbox.ebay.com';
      
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: mockAccessToken,
        apiHost: mockApiHost,
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({
          campaigns: [
            {
              campaignId: 'campaign-1',
              campaignName: 'Test Campaign',
              campaignStatus: 'RUNNING',
              fundingStrategy: {
                fundingModel: 'COST_PER_SALE',
                bidPercentage: '5.0',
              },
            },
          ],
        }),
      });

      const result = await getCampaigns('user123');

      expect(result.campaigns).toHaveLength(1);
      expect(result.campaigns[0].campaignId).toBe('campaign-1');
      expect(getEbayAccessToken).toHaveBeenCalledWith('user123');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/sell/marketing/v1/ad_campaign'),
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockAccessToken}`,
          }),
        })
      );
    });

    it('should handle API errors', async () => {
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: 'test-token',
        apiHost: 'https://api.sandbox.ebay.com',
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await expect(getCampaigns('user123')).rejects.toThrow('Failed to get campaigns 401: Unauthorized');
    });

    it('should handle empty campaigns list', async () => {
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: 'test-token',
        apiHost: 'https://api.sandbox.ebay.com',
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const result = await getCampaigns('user123');

      expect(result.campaigns).toEqual([]);
    });

    it('should respect limit parameter', async () => {
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: 'test-token',
        apiHost: 'https://api.sandbox.ebay.com',
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ campaigns: [] }),
      });

      await getCampaigns('user123', { limit: 50 });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('limit=50'),
        expect.any(Object)
      );
    });
  });

  describe('createCampaign', () => {
    it('should create a campaign successfully', async () => {
      const mockAccessToken = 'test-access-token';
      const mockApiHost = 'https://api.sandbox.ebay.com';
      
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: mockAccessToken,
        apiHost: mockApiHost,
      });

      const mockCampaign = {
        campaignId: 'new-campaign-123',
        campaignName: 'New Test Campaign',
        campaignStatus: 'RUNNING',
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => mockCampaign,
      });

      const result = await createCampaign('user123', {
        campaignName: 'New Test Campaign',
        startDate: '2025-01-01',
        fundingStrategy: {
          fundingModel: 'COST_PER_SALE',
          bidPercentage: '5.0',
        },
        marketplaceId: 'EBAY_US',
      });

      expect(result.campaignId).toBe('new-campaign-123');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/sell/marketing/v1/ad_campaign'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockAccessToken}`,
            'Content-Type': 'application/json',
          }),
          body: expect.any(String),
        })
      );
    });

    it('should handle creation errors', async () => {
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: 'test-token',
        apiHost: 'https://api.sandbox.ebay.com',
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Invalid campaign data',
      });

      await expect(
        createCampaign('user123', {
          campaignName: 'Invalid Campaign',
          startDate: '2025-01-01',
          fundingStrategy: {
            fundingModel: 'COST_PER_SALE',
            bidPercentage: '5.0',
          },
          marketplaceId: 'EBAY_US',
        })
      ).rejects.toThrow('Failed to create campaign 400: Invalid campaign data');
    });
  });

  describe('getAds', () => {
    it('should fetch ads for a campaign', async () => {
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: 'test-token',
        apiHost: 'https://api.sandbox.ebay.com',
      });

      const mockAds = {
        ads: [
          {
            adId: 'ad-123',
            listingId: 'listing-456',
            bidPercentage: '5.0',
            adStatus: 'ACTIVE',
          },
        ],
        total: 1,
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => mockAds,
      });

      const result = await getAds('user123', 'campaign-123');

      expect(result.ads).toHaveLength(1);
      expect(result.ads[0].adId).toBe('ad-123');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/sell/marketing/v1/ad_campaign/campaign-123/ad'),
        expect.any(Object)
      );
    });

    it('should handle empty ads list', async () => {
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: 'test-token',
        apiHost: 'https://api.sandbox.ebay.com',
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const result = await getAds('user123', 'campaign-123');

      expect(result.ads).toEqual([]);
    });
  });

  describe('createAds', () => {
    it('should create ads successfully with normal response', async () => {
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: 'test-token',
        apiHost: 'https://api.sandbox.ebay.com',
      });

      const mockResponse = {
        ads: [
          {
            adId: 'ad-new-123',
            listingId: 'listing-789',
            bidPercentage: '5.0',
          },
        ],
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify(mockResponse),
      });

      const payload = {
        listingId: 'listing-789',
        bidPercentage: '5.0',
      };

      const result = await createAds('user123', 'campaign-123', payload);

      expect(result.ads).toHaveLength(1);
      expect(result.ads[0].adId).toBe('ad-new-123');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/sell/marketing/v1/ad_campaign/campaign-123/ad'),
        expect.objectContaining({
          method: 'POST',
          body: expect.any(String),
        })
      );
    });

    it('should handle empty response from eBay (newly synced listings)', async () => {
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: 'test-token',
        apiHost: 'https://api.sandbox.ebay.com',
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: async () => '',
      });

      const payload = {
        listingId: 'listing-789',
        bidPercentage: '5.0',
      };

      const result = await createAds('user123', 'campaign-123', payload);

      expect(result.ads).toHaveLength(0);
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should handle whitespace-only response', async () => {
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: 'test-token',
        apiHost: 'https://api.sandbox.ebay.com',
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: async () => '   \n  \t  ',
      });

      const result = await createAds('user123', 'campaign-123', {
        listingId: 'listing-999',
        bidPercentage: '7.0',
      });

      expect(result.ads).toHaveLength(0);
    });

    it('should handle bulk ad creation with responses array', async () => {
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: 'test-token',
        apiHost: 'https://api.sandbox.ebay.com',
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ responses: [
          { adId: 'ad1', statusCode: 200 },
          { adId: 'ad2', statusCode: 200 },
        ] }),
      });

      const result = await createAds('user123', 'campaign-123', {
        requests: [
          { bidPercentage: '5.0', listingId: 'listing-1' },
          { bidPercentage: '6.0', listingId: 'listing-2' },
        ],
      });

      expect(result.ads).toHaveLength(2);
    });
  });

  describe('updateAdRate', () => {
    it('should update ad rate successfully using update_bid endpoint', async () => {
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: 'test-token',
        apiHost: 'https://api.sandbox.ebay.com',
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: async () => '',
      });

      await updateAdRate('user123', 'campaign-123', 'ad-456', 7.5);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/sell/marketing/v1/ad_campaign/campaign-123/ad/ad-456/update_bid'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('7.5'),
        })
      );
    });

    it('should handle update errors', async () => {
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: 'test-token',
        apiHost: 'https://api.sandbox.ebay.com',
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Ad not found',
      });

      await expect(
        updateAdRate('user123', 'campaign-123', 'ad-999', 5.0)
      ).rejects.toThrow('Failed to update ad rate 404: Ad not found');
    });
  });

  describe('deleteAd', () => {
    it('should delete ad successfully', async () => {
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: 'test-token',
        apiHost: 'https://api.sandbox.ebay.com',
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 204,
        json: async () => ({}),
      });

      await deleteAd('user123', 'campaign-123', 'ad-789');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/sell/marketing/v1/ad_campaign/campaign-123/ad/ad-789'),
        expect.objectContaining({
          method: 'DELETE',
        })
      );
    });

    it('should handle deletion errors', async () => {
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: 'test-token',
        apiHost: 'https://api.sandbox.ebay.com',
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Ad not found',
      });

      await expect(
        deleteAd('user123', 'campaign-123', 'ad-999')
      ).rejects.toThrow('Failed to delete ad 404: Ad not found');
    });
  });

  describe('promoteOfferOnce', () => {
    it('should promote an offer successfully', async () => {
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: 'test-token',
        apiHost: 'https://api.sandbox.ebay.com',
      });

      // Mock getCampaigns to return existing campaign
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(mockFetchResponse({
          campaigns: [
            {
              campaignId: 'existing-campaign',
              campaignName: 'DraftPilot – EBAY_US – Auto',
              campaignStatus: 'RUNNING',
              marketplaceId: 'EBAY_US',
            },
          ],
        }))
        // Mock getAds to check if ad already exists
        .mockResolvedValueOnce(mockFetchResponse({ ads: [] }))
        // Mock createAds
        .mockResolvedValueOnce(mockFetchResponse({
          ads: [
            {
              adId: 'new-ad-123',
              listingId: 'offer-456',
              bidPercentage: '5.0',
            },
          ],
        }));

      const result = await promoteOfferOnce({
        userId: 'user123',
        offerId: 'offer-456',
        marketplaceId: 'EBAY_US',
        config: {
          enabled: true,
          adRate: 5.0,
        },
      });

      expect(result.adId).toBe('new-ad-123');
    });

    it('should handle disabled promotion', async () => {
      await expect(
        promoteOfferOnce({
          userId: 'user123',
          offerId: 'offer-456',
          marketplaceId: 'EBAY_US',
          config: {
            enabled: false,
            adRate: 5.0,
          },
        })
      ).rejects.toThrow('Promoted listings are disabled in configuration.');
    });

    it('should skip promotion if ad already exists', async () => {
      (getEbayAccessToken as jest.Mock).mockResolvedValue({
        token: 'test-token',
        apiHost: 'https://api.sandbox.ebay.com',
      });

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(mockFetchResponse({
          campaigns: [
            {
              campaignId: 'existing-campaign',
              campaignName: 'DraftPilot – EBAY_US – Auto',
              campaignStatus: 'RUNNING',
              marketplaceId: 'EBAY_US',
            },
          ],
        }))
        .mockResolvedValueOnce(mockFetchResponse({
          ads: [
            {
              adId: 'existing-ad',
              inventoryReferenceId: 'offer-456',
              bidPercentage: '5.0',
            },
          ],
        }));

      const result = await promoteOfferOnce({
        userId: 'user123',
        offerId: 'offer-456',
        marketplaceId: 'EBAY_US',
        config: {
          enabled: true,
          adRate: 5.0,
        },
      });

      expect(result.adId).toBe('existing-ad');
    });
  });

  describe('promoteSingleListing', () => {
    it('should promote a listing with token cache', async () => {
      (mockTokenCache.get as jest.Mock).mockResolvedValue('cached-token');

      const mockStore = {
        get: jest.fn().mockResolvedValue({ promoCampaignId: 'campaign-123' }),
        put: jest.fn(),
      };
      (tokensStore as jest.Mock).mockReturnValue(mockStore);

      (global.fetch as jest.Mock)
        // Mock inventory item fetch
        .mockResolvedValueOnce(mockFetchResponse({ sku: 'sku-789' }, { headers: { get: () => '100' } }))
        // Mock offers fetch
        .mockResolvedValueOnce(mockFetchResponse({
          offers: [
            {
              offerId: 'offer-123',
              listing: { listingId: 'listing-456' },
            },
          ],
        }, { headers: { get: () => '100' } }))
        // Mock create ad
        .mockResolvedValueOnce(mockFetchResponse({
          ads: [{ adId: 'new-ad-123', bidPercentage: '6.0' }]
        }, { headers: { get: () => '0' } }));

      const result = await promoteSingleListing({
        tokenCache: mockTokenCache,
        userId: 'user123',
        ebayAccountId: 'account-456',
        inventoryReferenceId: 'sku-789',
        adRate: 6.0,
      });

      expect(result.enabled).toBe(true);
      expect(mockTokenCache.get).toHaveBeenCalledWith('user123');
    });

    it('should fetch token from blob storage if not cached', async () => {
      (mockTokenCache.get as jest.Mock).mockResolvedValue(null);
      
      let callCount = 0;
      const mockStore = {
        get: jest.fn().mockImplementation((key) => {
          callCount++;
          // First call is for ebay tokens
          if (callCount === 1 || key.includes('ebay-tokens')) {
            return Promise.resolve({
              refresh_token: 'refresh-123',
            });
          }
          // Second call is for policy defaults (campaign ID)
          return Promise.resolve({ promoCampaignId: 'campaign-123' });
        }),
        put: jest.fn(),
      };
      
      (tokensStore as jest.Mock).mockReturnValue(mockStore);
      
      (accessTokenFromRefresh as jest.Mock).mockResolvedValue({
        access_token: 'new-access-token',
      });

      (global.fetch as jest.Mock)
        // Mock inventory item fetch
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => '100' },
          json: async () => ({ sku: 'sku-789' }),
        })
        // Mock offers fetch
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => '100' },
          json: async () => ({
            offers: [
              {
                offerId: 'offer-123',
                listing: { listingId: 'listing-456' },
              },
            ],
          }),
        })
        // Mock create ad
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => '0' },
          json: async () => ({}),
        });

      const result = await promoteSingleListing({
        tokenCache: mockTokenCache,
        userId: 'user123',
        ebayAccountId: 'account-456',
        inventoryReferenceId: 'sku-789',
        adRate: 5.0,
      });

      expect(result.enabled).toBe(true);
      expect(accessTokenFromRefresh).toHaveBeenCalledWith(
        'refresh-123',
        expect.any(Array)
      );
      expect(mockTokenCache.set).toHaveBeenCalledWith('user123', 'new-access-token', 3600);
    });

    it('should use campaignIdOverride if provided', async () => {
      (mockTokenCache.get as jest.Mock).mockResolvedValue('cached-token');

      const mockStore = {
        get: jest.fn().mockResolvedValue({}),
        put: jest.fn(),
      };
      (tokensStore as jest.Mock).mockReturnValue(mockStore);

      (global.fetch as jest.Mock)
        // Mock inventory item fetch
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => '100' },
          json: async () => ({ sku: 'sku-789' }),
        })
        // Mock offers fetch
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => '100' },
          json: async () => ({
            offers: [
              {
                offerId: 'offer-123',
                listing: { listingId: 'listing-456' },
              },
            ],
          }),
        })
        // Mock create ad
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => '0' },
          json: async () => ({}),
        });

      await promoteSingleListing({
        tokenCache: mockTokenCache,
        userId: 'user123',
        ebayAccountId: 'account-456',
        inventoryReferenceId: 'sku-789',
        adRate: 5.0,
        campaignIdOverride: 'custom-campaign-id',
      });

      // Should skip getCampaigns and use the override
      expect(global.fetch).not.toHaveBeenCalledWith(
        expect.stringContaining('/ad_campaign?'),
        expect.any(Object)
      );
    });

    it('should handle missing refresh token', async () => {
      (mockTokenCache.get as jest.Mock).mockResolvedValue(null);
      
      const mockStore = {
        get: jest.fn().mockResolvedValue({}),
        put: jest.fn(),
      };
      
      (tokensStore as jest.Mock).mockReturnValue(mockStore);

      await expect(
        promoteSingleListing({
          tokenCache: mockTokenCache,
          userId: 'user123',
          ebayAccountId: 'account-456',
          inventoryReferenceId: 'sku-789',
          adRate: 5.0,
        })
      ).rejects.toThrow('No eBay refresh token found for user user123');
    });
  });

  describe('promoteSkusForUser', () => {
    it('should promote multiple SKUs successfully', async () => {
      const mockTokenCache = {
        get: jest.fn().mockResolvedValue('cached-token'),
        set: jest.fn(),
      };

      const mockStore = {
        get: jest.fn().mockResolvedValue({ promoCampaignId: 'campaign-123' }),
        put: jest.fn(),
      };
      (tokensStore as jest.Mock).mockReturnValue(mockStore);

      (global.fetch as jest.Mock)
        // First SKU - inventory fetch
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => '100' },
          json: async () => ({ sku: 'sku-1' }),
        })
        // First SKU - offers fetch
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => '100' },
          json: async () => ({
            offers: [{ offerId: 'offer-1', listing: { listingId: 'listing-1' } }],
          }),
        })
        // First SKU - create ad
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => '0' },
          json: async () => ({}),
        })
        // Second SKU - inventory fetch
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => '100' },
          json: async () => ({ sku: 'sku-2' }),
        })
        // Second SKU - offers fetch
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => '100' },
          json: async () => ({
            offers: [{ offerId: 'offer-2', listing: { listingId: 'listing-2' } }],
          }),
        })
        // Second SKU - create ad
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => '0' },
          json: async () => ({}),
        });

      const result = await promoteSkusForUser('user123', ['sku-1', 'sku-2'], 5.5, {
        tokenCache: mockTokenCache as any,
      });

      expect(result.results).toHaveLength(2);
      expect(result.campaignId).toBe('campaign-123');
      expect(result.results[0].status.enabled).toBe(true);
      expect(result.results[1].status.enabled).toBe(true);
    });

    it('should handle errors and continue processing', async () => {
      const mockTokenCache = {
        get: jest.fn().mockResolvedValue('cached-token'),
        set: jest.fn(),
      };

      const mockStore = {
        get: jest.fn().mockResolvedValue({ promoCampaignId: 'campaign-123' }),
        put: jest.fn(),
      };
      (tokensStore as jest.Mock).mockReturnValue(mockStore);

      (global.fetch as jest.Mock)
        // inventory fetch
        .mockResolvedValueOnce(mockFetchResponse({ sku: 'invalid-sku' }, { headers: { get: () => '100' } }))
        // offers fetch - no offers
        .mockResolvedValueOnce(mockFetchResponse({ offers: [] }, { headers: { get: () => '100' } }));

      const result = await promoteSkusForUser('user123', ['invalid-sku'], 5.0, {
        tokenCache: mockTokenCache as any,
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].status.enabled).toBe(false);
    });

    it('should return empty results for empty SKU list', async () => {
      const result = await promoteSkusForUser('user123', [], 5.0);

      expect(result.campaignId).toBe('');
      expect(result.results).toHaveLength(0);
    });
  });
});
