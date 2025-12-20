import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

type GetAccessTokenFn = typeof import('../../src/services/ebay.js')['getAccessToken'];
type CreateOfferFn = typeof import('../../src/services/ebay.js')['createOffer'];
type PublishOfferFn = typeof import('../../src/services/ebay.js')['publishOffer'];
type EnsureInventoryItemFn = typeof import('../../src/services/ebay.js')['ensureInventoryItem'];
type FetchFn = typeof fetch;

// Mock dependencies before importing router
const mockGetAccessToken: jest.MockedFunction<GetAccessTokenFn> = jest.fn();
const mockCreateOffer: jest.MockedFunction<CreateOfferFn> = jest.fn();
const mockPublishOffer: jest.MockedFunction<PublishOfferFn> = jest.fn();
const mockEnsureInventoryItem: jest.MockedFunction<EnsureInventoryItemFn> = jest.fn();
const mockFetch: jest.MockedFunction<FetchFn> = jest.fn();

const makeResponse = (status: number, textFn: () => Promise<string>): Response =>
  ({ status, text: textFn } as unknown as Response);

// Mock global fetch
global.fetch = mockFetch as any;

jest.mock('../../src/services/ebay.js', () => ({
  getAccessToken: mockGetAccessToken,
  createOffer: mockCreateOffer,
  publishOffer: mockPublishOffer,
  ensureInventoryItem: mockEnsureInventoryItem,
}));

jest.mock('../../src/config.js', () => ({
  cfg: {
    ebay: {
      env: 'SANDBOX',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
    },
  },
}));

import { offersRouter } from '../../src/routes/offers.js';

describe('offersRouter', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(offersRouter);
    jest.clearAllMocks();
  });

  describe('GET /me/ebay/offer/:offerId', () => {
    it('should fetch offer JSON from eBay', async () => {
      const mockOffer = {
        offerId: '123456',
        sku: 'TEST-SKU',
        format: 'FIXED_PRICE',
        pricingSummary: { price: { currency: 'USD', value: '29.99' } },
      };
      mockGetAccessToken.mockResolvedValue('test-token');
      mockFetch.mockResolvedValue(makeResponse(200, async () => JSON.stringify(mockOffer)));

      const response = await request(app).get('/me/ebay/offer/123456');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockOffer);
      expect(mockGetAccessToken).toHaveBeenCalledWith('demo');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.sandbox.ebay.com/sell/inventory/v1/offer/123456',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should handle non-JSON responses', async () => {
      mockGetAccessToken.mockResolvedValue('test-token');
      mockFetch.mockResolvedValue(makeResponse(400, async () => 'Invalid offer ID'));

      const response = await request(app).get('/me/ebay/offer/invalid');

      expect(response.status).toBe(400);
      expect(response.text).toBe('Invalid offer ID');
    });

    it('should handle eBay API errors', async () => {
      mockGetAccessToken.mockResolvedValue('test-token');
      mockFetch.mockResolvedValue(makeResponse(404, async () => JSON.stringify({ error: 'Offer not found' })));

      const response = await request(app).get('/me/ebay/offer/nonexistent');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Offer not found' });
    });

    it('should handle token retrieval errors', async () => {
      mockGetAccessToken.mockRejectedValue(new Error('Token expired'));

      const response = await request(app).get('/me/ebay/offer/123456');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Token expired' });
    });

    it('should handle network errors', async () => {
      mockGetAccessToken.mockResolvedValue('test-token');
      mockFetch.mockRejectedValue(new Error('Network timeout'));

      const response = await request(app).get('/me/ebay/offer/123456');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Network timeout' });
    });
  });

  describe('PUT /me/ebay/inventory/:sku', () => {
    it('should update inventory item successfully', async () => {
      mockEnsureInventoryItem.mockResolvedValue(undefined);

      const response = await request(app)
        .put('/me/ebay/inventory/TEST-SKU')
        .send({
          title: 'Updated Product',
          description: 'New description',
          condition: 'NEW',
          quantity: 10,
          imageUrls: ['https://example.com/image.jpg'],
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
      expect(mockEnsureInventoryItem).toHaveBeenCalledWith('demo', 'TEST-SKU', {
        title: 'Updated Product',
        description: 'New description',
        condition: 'NEW',
        quantity: 10,
        imageUrls: ['https://example.com/image.jpg'],
      });
    });

    it('should apply defaults for missing fields', async () => {
      mockEnsureInventoryItem.mockResolvedValue(undefined);

      const response = await request(app)
        .put('/me/ebay/inventory/TEST-SKU')
        .send({});

      expect(response.status).toBe(200);
      expect(mockEnsureInventoryItem).toHaveBeenCalledWith('demo', 'TEST-SKU', {
        title: 'Listing TEST-SKU',
        description: '',
        condition: 'NEW',
        quantity: 1,
        imageUrls: [],
      });
    });

    it('should handle inventory update errors', async () => {
      mockEnsureInventoryItem.mockRejectedValue(new Error('SKU already exists'));

      const response = await request(app)
        .put('/me/ebay/inventory/DUPLICATE-SKU')
        .send({ title: 'Test' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'SKU already exists' });
    });

    it('should handle validation errors', async () => {
      mockEnsureInventoryItem.mockRejectedValue(new Error('Invalid condition value'));

      const response = await request(app)
        .put('/me/ebay/inventory/TEST-SKU')
        .send({ condition: 'INVALID' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid condition value' });
    });
  });

  describe('PUT /me/ebay/offer/:offerId', () => {
    it('should update offer successfully', async () => {
      const existingOffer = {
        offerId: '123456',
        sku: 'TEST-SKU',
        pricingSummary: { price: { currency: 'USD', value: '19.99' } },
        availableQuantity: 5,
        listingPolicies: { paymentPolicyId: 'old-payment' },
      };
      mockGetAccessToken.mockResolvedValue('test-token');
      mockFetch
        .mockResolvedValueOnce(makeResponse(200, async () => JSON.stringify(existingOffer)))
        .mockResolvedValueOnce(makeResponse(200, async () => JSON.stringify({ ok: true })));

      const response = await request(app)
        .put('/me/ebay/offer/123456')
        .send({
          price: 24.99,
          availableQuantity: 10,
          listingPolicies: { returnPolicyId: 'new-return' },
        });

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // Verify PUT call includes updated values
      const putCall = (mockFetch as any).mock.calls[1];
      expect(putCall[0]).toContain('/sell/inventory/v1/offer/123456');
      expect(putCall[1].method).toBe('PUT');
      const putBody = JSON.parse(putCall[1].body);
      expect(putBody.pricingSummary.price.value).toBe('24.99');
      expect(putBody.availableQuantity).toBe(10);
      expect(putBody.listingPolicies.returnPolicyId).toBe('new-return');
    });

    it('should handle offer not found', async () => {
      mockGetAccessToken.mockResolvedValue('test-token');
      mockFetch.mockResolvedValue(makeResponse(404, async () => JSON.stringify({ error: 'Offer not found' })));

      const response = await request(app)
        .put('/me/ebay/offer/nonexistent')
        .send({ price: 10 });

      expect(response.status).toBe(404);
    });

    it('should handle JSON parse errors', async () => {
      mockGetAccessToken.mockResolvedValue('test-token');
      mockFetch.mockResolvedValue(makeResponse(200, async () => 'Invalid JSON'));

      const response = await request(app)
        .put('/me/ebay/offer/123456')
        .send({ price: 10 });

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error');
    });

    it('should handle update failures', async () => {
      const existingOffer = { offerId: '123456', sku: 'TEST-SKU' };
      mockGetAccessToken.mockResolvedValue('test-token');
      mockFetch
        .mockResolvedValueOnce(makeResponse(200, async () => JSON.stringify(existingOffer)))
        .mockResolvedValueOnce(makeResponse(400, async () => JSON.stringify({ error: 'Invalid price' })));

      const response = await request(app)
        .put('/me/ebay/offer/123456')
        .send({ price: -10 });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid price' });
    });
  });

  describe('POST /me/ebay/offer/:offerId/publish', () => {
    it('should publish offer successfully', async () => {
      const mockResult = {
        listingId: 'listing-789',
        status: 'PUBLISHED',
      };
      mockPublishOffer.mockResolvedValue(mockResult);

      const response = await request(app).post('/me/ebay/offer/123456/publish');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true, result: mockResult });
      expect(mockPublishOffer).toHaveBeenCalledWith('demo', '123456');
    });

    it('should handle publish errors', async () => {
      mockPublishOffer.mockRejectedValue(new Error('Offer already published'));

      const response = await request(app).post('/me/ebay/offer/123456/publish');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Offer already published' });
    });

    it('should handle missing required policies', async () => {
      mockPublishOffer.mockRejectedValue(new Error('Payment policy not set'));

      const response = await request(app).post('/me/ebay/offer/123456/publish');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Payment policy not set' });
    });

    it('should handle eBay API errors', async () => {
      mockPublishOffer.mockRejectedValue(new Error('eBay API rate limit exceeded'));

      const response = await request(app).post('/me/ebay/offer/123456/publish');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'eBay API rate limit exceeded' });
    });
  });
});
