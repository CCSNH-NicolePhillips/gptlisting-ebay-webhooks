import * as ebayService from '../../src/services/ebay';
import { fetch } from 'undici';
import fs from 'fs';
import path from 'path';
import { cfg } from '../../src/config.js';

// Mock dependencies
jest.mock('undici', () => ({
  fetch: jest.fn(),
}));

jest.mock('fs');
jest.mock('../../src/config.js', () => ({
  cfg: {
    dataDir: '/mock/data',
    ebay: {
      env: 'SANDBOX',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      ruName: 'https://test.com/callback',
      policy: {
        fulfillmentPolicyId: 'fulfillment-123',
        paymentPolicyId: 'payment-123',
        returnPolicyId: 'return-123',
      },
      merchantLocationKey: 'TestWarehouse',
    },
  },
}));

const mockFetch = fetch as jest.MockedFunction<typeof fetch>;
const mockFs = fs as jest.Mocked<typeof fs>;

describe('ebay service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Default mock for token file operations
    (mockFs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
      'testUser': {
        refresh_token: 'test-refresh-token',
        scope: 'test-scope',
      },
    }));
    (mockFs.writeFileSync as jest.Mock).mockImplementation(() => {});
    (mockFs.mkdirSync as jest.Mock).mockImplementation(() => {});
  });

  describe('buildEbayAuthUrl', () => {
    it('should generate sandbox auth URL with correct parameters', () => {
      const url = ebayService.buildEbayAuthUrl();
      
      expect(url).toContain('auth.sandbox.ebay.com/oauth2/authorize');
      expect(url).toContain('client_id=test-client-id');
      expect(url).toContain('redirect_uri=https%3A%2F%2Ftest.com%2Fcallback');
      expect(url).toContain('response_type=code');
      expect(url).toContain('scope=');
      expect(url).toContain('sell.inventory');
      expect(url).toContain('state=');
    });

    it('should generate production auth URL when env is PROD', () => {
      const originalEnv = cfg.ebay.env;
      cfg.ebay.env = 'PROD';
      
      const url = ebayService.buildEbayAuthUrl();
      
      expect(url).toContain('auth.ebay.com/oauth2/authorize');
      
      cfg.ebay.env = originalEnv;
    });
  });

  describe('exchangeAuthCode', () => {
    it('should exchange auth code for tokens', async () => {
      const mockTokenResponse = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        token_type: 'Bearer',
        expires_in: 7200,
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockTokenResponse,
      } as any);

      const result = await ebayService.exchangeAuthCode('test-auth-code');

      expect(result).toEqual(mockTokenResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: expect.stringContaining('Basic '),
          }),
          body: expect.stringContaining('grant_type=authorization_code'),
        })
      );
    });

    it('should throw error on failed exchange', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'invalid_grant' }),
      } as any);

      await expect(ebayService.exchangeAuthCode('bad-code')).rejects.toThrow();
    });
  });

  describe('saveEbayTokens', () => {
    it('should save tokens to file', async () => {
      const tokenResponse = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        scope: 'test-scope',
      };

      await ebayService.saveEbayTokens('newUser', tokenResponse);

      expect(mockFs.mkdirSync).toHaveBeenCalledWith('/mock/data', { recursive: true });
      expect(mockFs.writeFileSync).toHaveBeenCalled();
      
      // Verify the JSON content contains the new token
      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const jsonContent = writeCall[1] as string;
      const parsed = JSON.parse(jsonContent);
      expect(parsed.newUser.refresh_token).toBe('new-refresh-token');
      expect(parsed.newUser.scope).toBe('test-scope');
    });

    it('should preserve existing user tokens', async () => {
      await ebayService.saveEbayTokens('anotherUser', {
        access_token: 'another-access',
        refresh_token: 'another-refresh',
        scope: 'another-scope',
      });

      const savedData = JSON.parse((mockFs.writeFileSync as jest.Mock).mock.calls[0][1]);
      expect(savedData.testUser).toBeDefined();
      expect(savedData.anotherUser).toBeDefined();
    });
  });

  describe('getAccessToken', () => {
    it('should refresh and return access token', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'fresh-access-token' }),
      } as any);

      const token = await ebayService.getAccessToken('testUser');

      expect(token).toBe('fresh-access-token');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('grant_type=refresh_token'),
        })
      );
    });

    it('should throw error when user has no refresh token', async () => {
      (mockFs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({}));

      await expect(ebayService.getAccessToken('unknownUser')).rejects.toThrow(
        'eBay not connected for user unknownUser'
      );
    });

    it('should throw error on failed token refresh', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'invalid_token' }),
      } as any);

      await expect(ebayService.getAccessToken('testUser')).rejects.toThrow();
    });
  });

  describe('whoAmI', () => {
    it('should return user info', async () => {
      const mockUserInfo = { userId: 'test-user-123', username: 'testuser' };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token' }),
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockUserInfo,
      } as any);

      const result = await ebayService.whoAmI('testUser');

      expect(result).toEqual(mockUserInfo);
    });

    it('should return fallback for 404 response (sandbox)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token' }),
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({}),
      } as any);

      const result = await ebayService.whoAmI('testUser');

      expect(result).toEqual({ userId: 'unknown' });
    });
  });

  describe('ensureInventoryItem', () => {
    it('should create inventory item successfully', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      // Mock inventory item PUT
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
      } as any);

      await ebayService.ensureInventoryItem('testUser', 'test-sku-123', {
        title: 'Test Product',
        description: 'Test description',
        condition: 'NEW',
        quantity: 10,
        imageUrls: ['https://example.com/image.jpg'],
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/sell/inventory/v1/inventory_item/test-sku-123'),
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('Test Product'),
        })
      );
    });

    it('should throw error on failure', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      // Mock failed PUT
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'Invalid data' }),
      } as any);

      await expect(
        ebayService.ensureInventoryItem('testUser', 'bad-sku', {
          title: 'Bad Product',
          description: 'Bad',
          condition: 'NEW',
          quantity: 1,
          imageUrls: [],
        })
      ).rejects.toThrow();
    });
  });

  describe('createOffer', () => {
    it('should create offer successfully', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      const mockOfferResponse = { offerId: 'offer-123' };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockOfferResponse),
      } as any);

      const result = await ebayService.createOffer('testUser', 'test-sku', {
        marketplaceId: 'EBAY_US',
        categoryId: '12345',
        price: 29.99,
        quantity: 5,
      });

      expect(result).toEqual(mockOfferResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/sell/inventory/v1/offer'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('test-sku'),
        })
      );
    });

    it('should include policy IDs in offer', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ offerId: 'offer-123' }),
      } as any);

      await ebayService.createOffer('testUser', 'test-sku', {
        marketplaceId: 'EBAY_US',
        categoryId: '12345',
        price: 29.99,
        quantity: 5,
      });

      const callBody = JSON.parse((mockFetch.mock.calls[1][1] as any).body);
      expect(callBody.listingPolicies.fulfillmentPolicyId).toBe('fulfillment-123');
      expect(callBody.listingPolicies.paymentPolicyId).toBe('payment-123');
      expect(callBody.listingPolicies.returnPolicyId).toBe('return-123');
    });

    it('should throw error on failure', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'Invalid offer' }),
      } as any);

      await expect(
        ebayService.createOffer('testUser', 'bad-sku', {
          marketplaceId: 'EBAY_US',
          categoryId: '12345',
          price: -1,
          quantity: 0,
        })
      ).rejects.toThrow();
    });
  });

  describe('publishOffer', () => {
    it('should publish offer successfully', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      const mockPublishResponse = { listingId: 'listing-123' };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockPublishResponse,
      } as any);

      const result = await ebayService.publishOffer('testUser', 'offer-123');

      expect(result).toEqual(mockPublishResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/sell/inventory/v1/offer/offer-123/publish'),
        expect.objectContaining({
          method: 'POST',
        })
      );
    });

    it('should throw error on publish failure', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Publish failed',
      } as any);

      await expect(ebayService.publishOffer('testUser', 'bad-offer')).rejects.toThrow(
        'Publish failed'
      );
    });
  });

  describe('optInSellingPolicies', () => {
    it('should opt in to selling policies', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as any);

      await ebayService.optInSellingPolicies('testUser');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/sell/account/v1/program/opt_in'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('SELLING_POLICY_MANAGEMENT'),
        })
      );
    });

    it('should handle 409 conflict (already opted in)', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({}),
      } as any);

      await expect(ebayService.optInSellingPolicies('testUser')).resolves.not.toThrow();
    });

    it('should handle benign error 20403', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          errors: [{ errorId: '20403' }],
        }),
      } as any);

      await expect(ebayService.optInSellingPolicies('testUser')).resolves.not.toThrow();
    });

    it('should throw on non-benign errors', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          errors: [{ errorId: '99999', message: 'Unknown error' }],
        }),
      } as any);

      await expect(ebayService.optInSellingPolicies('testUser')).rejects.toThrow();
    });
  });

  describe('ensureEbayPrereqs', () => {
    it('should ensure all prerequisites are set up', async () => {
      // Mock opt-in call (token + API)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as any);

      // The 4 parallel operations (ensurePaymentPolicy, ensureReturnPolicy, ensureFulfillmentPolicy, ensureInventoryLocation)
      // first all call their list functions simultaneously, so all token refreshes happen, then all API calls
      
      // Mock 4 token refreshes for the parallel list calls
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      // Mock 4 list API responses (all empty)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ paymentPolicies: [] }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ returnPolicies: [] }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ fulfillmentPolicies: [] }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ locations: [] }),
      } as any);

      // Now each function will call create, so 4 more token refreshes
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      // Mock 4 create API responses
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ paymentPolicyId: 'payment-new-123' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ returnPolicyId: 'return-new-123' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ fulfillmentPolicyId: 'fulfillment-new-123' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '',
      } as any);

      const result = await ebayService.ensureEbayPrereqs('testUser');

      expect(result).toEqual({
        paymentPolicyId: expect.any(String),
        returnPolicyId: expect.any(String),
        fulfillmentPolicyId: expect.any(String),
        merchantLocationKey: expect.any(String),
      });
    });

    it('should use existing policies when available', async () => {
      // Mock opt-in call (token + API)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as any);

      // Mock 4 token refreshes for the parallel list calls
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      // Mock 4 list API responses (all with existing policies/locations)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          paymentPolicies: [{ name: 'Auto Payment Policy', paymentPolicyId: 'existing-pay-123' }],
        }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          returnPolicies: [{ name: 'Auto Return Policy', returnPolicyId: 'existing-return-123' }],
        }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          fulfillmentPolicies: [
            { name: 'Auto Shipping Policy', fulfillmentPolicyId: 'existing-fulfill-123' },
          ],
        }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          locations: [{ merchantLocationKey: 'AutoWarehouse01' }],
        }),
      } as any);

      // No create calls needed since all policies exist

      const result = await ebayService.ensureEbayPrereqs('testUser');

      expect(result.paymentPolicyId).toBe('existing-pay-123');
      expect(result.returnPolicyId).toBe('existing-return-123');
      expect(result.fulfillmentPolicyId).toBe('existing-fulfill-123');
      expect(result.merchantLocationKey).toBe('AutoWarehouse01');
    });
  });

  describe('listPolicies', () => {
    it('should list all policy types', async () => {
      // Mock token refresh (3 calls - one per policy type)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ paymentPolicies: [{ paymentPolicyId: 'pay-1' }] }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ returnPolicies: [{ returnPolicyId: 'return-1' }] }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ fulfillmentPolicies: [{ fulfillmentPolicyId: 'fulfill-1' }] }),
      } as any);

      const result = await ebayService.listPolicies('testUser');

      expect(result.paymentPolicies).toHaveLength(1);
      expect(result.returnPolicies).toHaveLength(1);
      expect(result.fulfillmentPolicies).toHaveLength(1);
    });

    it('should return empty arrays when no policies exist', async () => {
      // Mock token refresh (3 calls)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as any);

      const result = await ebayService.listPolicies('testUser');

      expect(result.paymentPolicies).toEqual([]);
      expect(result.returnPolicies).toEqual([]);
      expect(result.fulfillmentPolicies).toEqual([]);
    });
  });

  describe('listInventoryLocations', () => {
    it('should list inventory locations', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      const mockLocations = [
        { merchantLocationKey: 'warehouse-1', name: 'Main Warehouse' },
        { merchantLocationKey: 'warehouse-2', name: 'Secondary Warehouse' },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ locations: mockLocations }),
      } as any);

      const result = await ebayService.listInventoryLocations('testUser');

      expect(result).toEqual(mockLocations);
    });

    it('should return empty array when no locations exist', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as any);

      const result = await ebayService.listInventoryLocations('testUser');

      expect(result).toEqual([]);
    });

    it('should throw error on API failure', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'API error' }),
      } as any);

      await expect(ebayService.listInventoryLocations('testUser')).rejects.toThrow();
    });
  });
});
