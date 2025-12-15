/**
 * Tests for ebay-adapter.ts
 * eBay API adapter for offer management
 */

// Set up env vars before imports
process.env.EBAY_MARKETPLACE_ID = 'EBAY_US';
process.env.EBAY_ENV = 'production';

import { fetchOffer, updateOfferPrice } from '../../src/lib/ebay-adapter.js';

// Mock global fetch
global.fetch = jest.fn();

// Mock _blobs module
jest.mock('../../src/lib/_blobs.js', () => ({
  tokensStore: jest.fn()
}));

// Mock _common module
jest.mock('../../src/lib/_common.js', () => ({
  accessTokenFromRefresh: jest.fn(),
  tokenHosts: jest.fn(() => ({ apiHost: 'https://api.ebay.com' }))
}));

import { tokensStore } from '../../src/lib/_blobs.js';
import { accessTokenFromRefresh } from '../../src/lib/_common.js';

describe('ebay-adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockReset();
  });

  describe('fetchOffer', () => {
    it('should fetch offer with cached token', async () => {
      const mockOffer = {
        offerId: 'offer-123',
        pricingSummary: {
          price: {
            value: 99.99,
            currency: 'USD'
          }
        },
        sku: 'TEST-SKU-001'
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockOffer)
      } as any);

      const tokenCache = new Map<string, string>();
      tokenCache.set('user-123', 'cached-token-abc');

      const result = await fetchOffer('user-123', 'offer-123', { tokenCache });

      expect(result.offer).toEqual(mockOffer);
      expect(result.price).toBe(99.99);
      expect(result.currency).toBe('USD');

      // Verify fetch was called with correct URL and headers
      expect(fetch).toHaveBeenCalledWith(
        'https://api.ebay.com/sell/inventory/v1/offer/offer-123',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer cached-token-abc',
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
          })
        })
      );
    });

    it('should fetch token from storage when not cached', async () => {
      const mockStore = {
        get: jest.fn().mockResolvedValue({
          refresh_token: 'refresh-token-xyz'
        })
      };

      (tokensStore as jest.Mock).mockReturnValue(mockStore);
      (accessTokenFromRefresh as jest.Mock).mockResolvedValue({
        access_token: 'new-access-token'
      });

      const mockOffer = {
        offerId: 'offer-456',
        pricingSummary: {
          price: {
            value: 49.99,
            currency: 'USD'
          }
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockOffer)
      } as any);

      const result = await fetchOffer('user-456', 'offer-456');

      expect(result.price).toBe(49.99);
      expect(mockStore.get).toHaveBeenCalled();
      expect(accessTokenFromRefresh).toHaveBeenCalledWith('refresh-token-xyz');
    });

    it('should throw if userId is empty', async () => {
      await expect(
        fetchOffer('', 'offer-123')
      ).rejects.toThrow('Missing userId for eBay access');
    });

    it('should throw if offerId is empty', async () => {
      const tokenCache = new Map<string, string>();
      tokenCache.set('user-123', 'token');

      await expect(
        fetchOffer('user-123', '', { tokenCache })
      ).rejects.toThrow('Missing offerId');
    });

    it('should throw if no refresh token found', async () => {
      const mockStore = {
        get: jest.fn().mockResolvedValue(null)
      };

      (tokensStore as jest.Mock).mockReturnValue(mockStore);

      await expect(
        fetchOffer('user-789', 'offer-789')
      ).rejects.toThrow('No eBay refresh token found for user user-789');
    });

    it('should throw if access token exchange fails', async () => {
      const mockStore = {
        get: jest.fn().mockResolvedValue({
          refresh_token: 'refresh-token-abc'
        })
      };

      (tokensStore as jest.Mock).mockReturnValue(mockStore);
      (accessTokenFromRefresh as jest.Mock).mockResolvedValue({});

      await expect(
        fetchOffer('user-999', 'offer-999')
      ).rejects.toThrow('Failed to exchange refresh token for access token');
    });

    it('should throw on API error response', async () => {
      const tokenCache = new Map<string, string>();
      tokenCache.set('user-error', 'token-error');

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Offer not found'
      } as any);

      await expect(
        fetchOffer('user-error', 'offer-missing', { tokenCache })
      ).rejects.toThrow('Offer fetch failed 404: Offer not found');
    });

    it('should throw on invalid JSON response', async () => {
      const tokenCache = new Map<string, string>();
      tokenCache.set('user-bad', 'token-bad');

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => 'Not valid JSON{{'
      } as any);

      await expect(
        fetchOffer('user-bad', 'offer-bad', { tokenCache })
      ).rejects.toThrow('Offer fetch returned invalid JSON');
    });

    it('should handle missing price in offer', async () => {
      const mockOffer = {
        offerId: 'offer-no-price',
        sku: 'SKU-001'
      };

      const tokenCache = new Map<string, string>();
      tokenCache.set('user-123', 'token-123');

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockOffer)
      } as any);

      const result = await fetchOffer('user-123', 'offer-no-price', { tokenCache });

      expect(result.price).toBeNull();
      expect(result.currency).toBe('USD'); // default
    });

    it('should handle zero price', async () => {
      const mockOffer = {
        offerId: 'offer-zero',
        pricingSummary: {
          price: {
            value: 0,
            currency: 'EUR'
          }
        }
      };

      const tokenCache = new Map<string, string>();
      tokenCache.set('user-123', 'token-123');

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockOffer)
      } as any);

      const result = await fetchOffer('user-123', 'offer-zero', { tokenCache });

      expect(result.price).toBeNull(); // zero is treated as null
      expect(result.currency).toBe('EUR');
    });

    it('should round price to 2 decimals', async () => {
      const mockOffer = {
        offerId: 'offer-round',
        pricingSummary: {
          price: {
            value: 19.996,
            currency: 'USD'
          }
        }
      };

      const tokenCache = new Map<string, string>();
      tokenCache.set('user-123', 'token-123');

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockOffer)
      } as any);

      const result = await fetchOffer('user-123', 'offer-round', { tokenCache });

      expect(result.price).toBe(20.0); // rounded
    });

    it('should trim whitespace from userId and offerId', async () => {
      const mockOffer = {
        offerId: 'offer-trim',
        pricingSummary: {
          price: { value: 10.00, currency: 'USD' }
        }
      };

      const tokenCache = new Map<string, string>();
      tokenCache.set('user-trim', 'token-trim');

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(mockOffer)
      } as any);

      await fetchOffer('  user-trim  ', '  offer-trim  ', { tokenCache });

      const url = (fetch as jest.Mock).mock.calls[0][0];
      expect(url).toContain('/offer/offer-trim');
    });
  });

  describe('updateOfferPrice', () => {
    it('should update offer price successfully', async () => {
      const tokenCache = new Map<string, string>();
      tokenCache.set('user-update', 'token-update');

      const currentOffer = {
        offerId: 'offer-update',
        pricingSummary: {
          price: { value: 50.00, currency: 'USD' }
        },
        sku: 'SKU-UPDATE'
      };

      const updatedOffer = {
        ...currentOffer,
        pricingSummary: {
          price: { value: 75.00, currency: 'USD' }
        }
      };

      (global.fetch as jest.Mock)
        // GET offer
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(currentOffer)
        } as any)
        // PUT update
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(updatedOffer)
        } as any);

      const result = await updateOfferPrice('user-update', 'offer-update', 75.00, { tokenCache });

      expect(result.priceBefore).toBe(50.00);
      expect(result.priceAfter).toBe(75.00);
      expect(result.offer.pricingSummary.price.value).toBe(75.00);

      // Verify PUT was called
      const putCall = (fetch as jest.Mock).mock.calls[1];
      expect(putCall[1].method).toBe('PUT');
      expect(putCall[1].headers['Content-Type']).toBe('application/json');
    });

    it('should perform dryRun without updating', async () => {
      const tokenCache = new Map<string, string>();
      tokenCache.set('user-dry', 'token-dry');

      const currentOffer = {
        offerId: 'offer-dry',
        pricingSummary: {
          price: { value: 30.00, currency: 'USD' }
        }
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(currentOffer)
      } as any);

      const result = await updateOfferPrice('user-dry', 'offer-dry', 40.00, {
        tokenCache,
        dryRun: true
      });

      expect(result.priceBefore).toBe(30.00);
      expect(result.priceAfter).toBe(40.00);
      expect(result.offer.pricingSummary.price.value).toBe('40.00');

      // Should only have called GET, not PUT
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should throw on invalid price', async () => {
      const tokenCache = new Map<string, string>();
      tokenCache.set('user-bad', 'token-bad');

      await expect(
        updateOfferPrice('user-bad', 'offer-bad', 0, { tokenCache })
      ).rejects.toThrow('Invalid price value');

      await expect(
        updateOfferPrice('user-bad', 'offer-bad', -10, { tokenCache })
      ).rejects.toThrow('Invalid price value');
    });

    it('should throw if offer fetch fails', async () => {
      const tokenCache = new Map<string, string>();
      tokenCache.set('user-fail', 'token-fail');

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error'
      } as any);

      await expect(
        updateOfferPrice('user-fail', 'offer-fail', 25.00, { tokenCache })
      ).rejects.toThrow('Offer fetch failed 500');
    });

    it('should throw if offer update fails', async () => {
      const tokenCache = new Map<string, string>();
      tokenCache.set('user-update-fail', 'token-update-fail');

      const currentOffer = {
        offerId: 'offer-update-fail',
        pricingSummary: {
          price: { value: 20.00, currency: 'USD' }
        }
      };

      (global.fetch as jest.Mock)
        // GET succeeds
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(currentOffer)
        } as any)
        // PUT fails
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () => 'Bad Request'
        } as any);

      await expect(
        updateOfferPrice('user-update-fail', 'offer-update-fail', 30.00, { tokenCache })
      ).rejects.toThrow('Offer update failed 400');
    });

    it('should cleanup offer payload', async () => {
      const tokenCache = new Map<string, string>();
      tokenCache.set('user-cleanup', 'token-cleanup');

      const currentOffer = {
        offerId: 'offer-cleanup',
        pricingSummary: {
          price: { value: 15.00, currency: 'USD' }
        },
        errors: ['some error'],
        warnings: ['some warning'],
        marketplaceFees: { amount: 1.50 },
        marketplaceFeesCalculationStatus: 'CALCULATED',
        marketplaceFeesSummary: { total: 1.50 }
      };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(currentOffer)
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => '{}'
        } as any);

      await updateOfferPrice('user-cleanup', 'offer-cleanup', 20.00, { tokenCache });

      const putCall = (fetch as jest.Mock).mock.calls[1];
      const bodyPayload = JSON.parse(putCall[1].body);

      // Should not contain these fields
      expect(bodyPayload.errors).toBeUndefined();
      expect(bodyPayload.warnings).toBeUndefined();
      expect(bodyPayload.marketplaceFees).toBeUndefined();
      expect(bodyPayload.marketplaceFeesCalculationStatus).toBeUndefined();
      expect(bodyPayload.marketplaceFeesSummary).toBeUndefined();

      // Should contain price update
      expect(bodyPayload.pricingSummary.price.value).toBe('20.00');
    });

    it('should handle non-JSON update response', async () => {
      const tokenCache = new Map<string, string>();
      tokenCache.set('user-nojson', 'token-nojson');

      const currentOffer = {
        offerId: 'offer-nojson',
        pricingSummary: {
          price: { value: 10.00, currency: 'USD' }
        }
      };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(currentOffer)
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => 'OK' // Not JSON
        } as any);

      const result = await updateOfferPrice('user-nojson', 'offer-nojson', 12.00, { tokenCache });

      // Should still return result with payload
      expect(result.priceAfter).toBe(12.00);
      expect(result.offer).toBeDefined();
    });

    it('should preserve currency from original offer', async () => {
      const tokenCache = new Map<string, string>();
      tokenCache.set('user-currency', 'token-currency');

      const currentOffer = {
        offerId: 'offer-currency',
        pricingSummary: {
          price: { value: 100.00, currency: 'GBP' }
        }
      };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(currentOffer)
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => '{}'
        } as any);

      await updateOfferPrice('user-currency', 'offer-currency', 120.00, { tokenCache });

      const putCall = (fetch as jest.Mock).mock.calls[1];
      const bodyPayload = JSON.parse(putCall[1].body);

      expect(bodyPayload.pricingSummary.price.currency).toBe('GBP');
    });

    it('should round price to 2 decimals in update', async () => {
      const tokenCache = new Map<string, string>();
      tokenCache.set('user-round', 'token-round');

      const currentOffer = {
        offerId: 'offer-round',
        pricingSummary: {
          price: { value: 10.00, currency: 'USD' }
        }
      };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(currentOffer)
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => '{}'
        } as any);

      const result = await updateOfferPrice('user-round', 'offer-round', 19.996, { tokenCache });

      expect(result.priceAfter).toBe(20.00);

      const putCall = (fetch as jest.Mock).mock.calls[1];
      const bodyPayload = JSON.parse(putCall[1].body);
      expect(bodyPayload.pricingSummary.price.value).toBe('20.00');
    });

    it('should create pricingSummary if missing', async () => {
      const tokenCache = new Map<string, string>();
      tokenCache.set('user-missing', 'token-missing');

      const currentOffer = {
        offerId: 'offer-missing-price',
        sku: 'SKU-001'
        // No pricingSummary
      };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(currentOffer)
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => '{}'
        } as any);

      await updateOfferPrice('user-missing', 'offer-missing-price', 50.00, { tokenCache });

      const putCall = (fetch as jest.Mock).mock.calls[1];
      const bodyPayload = JSON.parse(putCall[1].body);

      expect(bodyPayload.pricingSummary).toBeDefined();
      expect(bodyPayload.pricingSummary.price.value).toBe('50.00');
      expect(bodyPayload.pricingSummary.price.currency).toBe('USD');
    });

    it('should use tokenCache to avoid refetching token', async () => {
      const mockStore = {
        get: jest.fn()
      };
      (tokensStore as jest.Mock).mockReturnValue(mockStore);

      const tokenCache = new Map<string, string>();
      tokenCache.set('user-cached', 'cached-token-123');

      const currentOffer = {
        offerId: 'offer-cached',
        pricingSummary: {
          price: { value: 5.00, currency: 'USD' }
        }
      };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(currentOffer)
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => '{}'
        } as any);

      await updateOfferPrice('user-cached', 'offer-cached', 10.00, { tokenCache });

      // Should not have called tokensStore
      expect(mockStore.get).not.toHaveBeenCalled();
    });
  });
});
