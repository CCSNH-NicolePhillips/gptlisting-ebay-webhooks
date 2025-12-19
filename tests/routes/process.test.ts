import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Mock dependencies before importing router
const mockListFolder = jest.fn();
const mockGetRawLink = jest.fn();
const mockEnsureInventoryItem = jest.fn();
const mockCreateOffer = jest.fn();
const mockPublishOffer = jest.fn();
const mockEnsureEbayPrereqs = jest.fn();
const mockGroupProductsFromDropbox = jest.fn();
const mockComputeEbayPrice = jest.fn();
const mockComputeFloorPrice = jest.fn();
const mockFs = {
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
};

jest.mock('../../src/services/dropbox.js', () => ({
  listFolder: mockListFolder,
  getRawLink: mockGetRawLink,
}));

jest.mock('../../src/services/ebay.js', () => ({
  ensureInventoryItem: mockEnsureInventoryItem,
  createOffer: mockCreateOffer,
  publishOffer: mockPublishOffer,
  ensureEbayPrereqs: mockEnsureEbayPrereqs,
}));

jest.mock('../../src/utils/grouping.js', () => ({
  groupProductsFromDropbox: mockGroupProductsFromDropbox,
}));

jest.mock('../../src/utils/pricing.js', () => ({
  computeEbayPrice: mockComputeEbayPrice,
  computeFloorPrice: mockComputeFloorPrice,
}));

jest.mock('fs', () => mockFs);

jest.mock('../../src/config.js', () => ({
  cfg: {
    dataDir: '/tmp/test',
    ebay: {
      env: 'SANDBOX',
      policy: {
        paymentPolicyId: 'payment-123',
        returnPolicyId: 'return-456',
        fulfillmentPolicyId: 'fulfillment-789',
      },
      merchantLocationKey: 'location-abc',
      defaultCategoryId: '99',
    },
  },
}));

import { processRouter } from '../../src/routes/process.js';

describe('processRouter', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(processRouter);
    jest.clearAllMocks();
  });

  describe('POST /process', () => {
    it('should process Dropbox folder and create drafts', async () => {
      const mockEntries = {
        entries: [
          { name: 'product1-front.jpg', path_lower: '/ebay/product1-front.jpg' },
          { name: 'product1-back.jpg', path_lower: '/ebay/product1-back.jpg' },
        ],
      };
      const mockGroups = [
        {
          sku: 'SKU-001',
          priceImageName: 'price-29.99.jpg',
          main: { path_lower: '/ebay/product1-front.jpg' },
          gallery: [{ path_lower: '/ebay/product1-back.jpg' }],
        },
      ];
      mockListFolder.mockResolvedValue(mockEntries);
      mockGroupProductsFromDropbox.mockReturnValue(mockGroups);
      mockGetRawLink
        .mockResolvedValueOnce('https://dropbox.com/raw/front.jpg')
        .mockResolvedValueOnce('https://dropbox.com/raw/back.jpg');
      mockComputeEbayPrice.mockReturnValue(34.99);
      mockComputeFloorPrice.mockReturnValue(29.99);
      mockEnsureInventoryItem.mockResolvedValue(undefined);
      mockCreateOffer.mockResolvedValue({ offerId: 'offer-123' });
      mockFs.existsSync.mockReturnValue(false);

      const response = await request(app)
        .post('/process')
        .send({ folderPath: '/EBAY', quantityDefault: 1 });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.count).toBe(1);
      expect(response.body.results[0]).toMatchObject({
        sku: 'SKU-001',
        offerId: 'offer-123',
        mode: 'draft',
        price: 34.99,
        floor: 29.99,
      });
      expect(mockListFolder).toHaveBeenCalledWith('demo', '/EBAY');
      expect(mockCreateOffer).toHaveBeenCalledWith('demo', 'SKU-001', expect.any(Object));
      expect(mockPublishOffer).not.toHaveBeenCalled();
    });

    it('should publish offers when mode is post', async () => {
      const mockEntries = { entries: [] };
      const mockGroups = [
        {
          sku: 'SKU-002',
          priceImageName: '15.00',
          main: { path_lower: '/ebay/item.jpg' },
          gallery: [],
        },
      ];
      mockListFolder.mockResolvedValue(mockEntries);
      mockGroupProductsFromDropbox.mockReturnValue(mockGroups);
      mockGetRawLink.mockResolvedValue('https://dropbox.com/raw/item.jpg');
      mockComputeEbayPrice.mockReturnValue(17.99);
      mockComputeFloorPrice.mockReturnValue(15.00);
      mockEnsureInventoryItem.mockResolvedValue(undefined);
      mockCreateOffer.mockResolvedValue({ offerId: 'offer-456' });
      mockPublishOffer.mockResolvedValue({ listingId: 'listing-789' });
      mockFs.existsSync.mockReturnValue(false);

      const response = await request(app)
        .post('/process')
        .send({ mode: 'post', quantityDefault: 1 });

      expect(response.status).toBe(200);
      expect(response.body.results[0].mode).toBe('post');
      expect(mockPublishOffer).toHaveBeenCalledWith('demo', 'offer-456');
    });

    it('should use category map when available', async () => {
      const mockEntries = { entries: [] };
      const mockGroups = [
        {
          sku: 'BOOK-001',
          priceImageName: '12.99',
          main: { path_lower: '/ebay/book.jpg' },
          gallery: [],
        },
      ];
      mockListFolder.mockResolvedValue(mockEntries);
      mockGroupProductsFromDropbox.mockReturnValue(mockGroups);
      mockGetRawLink.mockResolvedValue('https://dropbox.com/raw/book.jpg');
      mockComputeEbayPrice.mockReturnValue(14.99);
      mockComputeFloorPrice.mockReturnValue(12.99);
      mockEnsureInventoryItem.mockResolvedValue(undefined);
      mockCreateOffer.mockResolvedValue({ offerId: 'offer-789' });
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ 'BOOK-001': '267' }));

      const response = await request(app)
        .post('/process')
        .send({ quantityDefault: 1 });

      expect(response.status).toBe(200);
      expect(mockCreateOffer).toHaveBeenCalledWith(
        'demo',
        'BOOK-001',
        expect.objectContaining({ categoryId: '267' })
      );
    });

    it('should auto-provision eBay prerequisites when missing', async () => {
      // Remove policies from cfg to trigger auto-provision
      const { cfg } = await import('../../src/config.js');
      cfg.ebay.policy.paymentPolicyId = '';
      cfg.ebay.policy.returnPolicyId = '';
      cfg.ebay.policy.fulfillmentPolicyId = '';
      cfg.ebay.merchantLocationKey = '';

      const mockPrereqs = {
        paymentPolicyId: 'new-payment',
        returnPolicyId: 'new-return',
        fulfillmentPolicyId: 'new-fulfillment',
        merchantLocationKey: 'new-location',
      };
      mockEnsureEbayPrereqs.mockResolvedValue(mockPrereqs);
      mockListFolder.mockResolvedValue({ entries: [] });
      mockGroupProductsFromDropbox.mockReturnValue([]);

      const response = await request(app).post('/process').send({});

      expect(response.status).toBe(200);
      expect(mockEnsureEbayPrereqs).toHaveBeenCalledWith('demo');
      expect(cfg.ebay.policy.paymentPolicyId).toBe('new-payment');
    });

    it('should skip groups with no images', async () => {
      const mockEntries = { entries: [] };
      const mockGroups = [
        { sku: 'NO-IMAGES', priceImageName: '0', main: null, gallery: [] },
      ];
      mockListFolder.mockResolvedValue(mockEntries);
      mockGroupProductsFromDropbox.mockReturnValue(mockGroups);

      const response = await request(app).post('/process').send({});

      expect(response.status).toBe(200);
      expect(response.body.results[0]).toEqual({
        sku: 'NO-IMAGES',
        error: 'no images found',
        mode: 'draft',
      });
      expect(mockEnsureInventoryItem).not.toHaveBeenCalled();
    });

    it('should handle inventory creation errors', async () => {
      const mockEntries = { entries: [] };
      const mockGroups = [
        {
          sku: 'ERROR-SKU',
          priceImageName: '10',
          main: { path_lower: '/ebay/error.jpg' },
          gallery: [],
        },
      ];
      mockListFolder.mockResolvedValue(mockEntries);
      mockGroupProductsFromDropbox.mockReturnValue(mockGroups);
      mockGetRawLink.mockResolvedValue('https://dropbox.com/raw/error.jpg');
      mockComputeEbayPrice.mockReturnValue(12.99);
      mockComputeFloorPrice.mockReturnValue(10.00);
      mockEnsureInventoryItem.mockRejectedValue(new Error('Inventory error'));
      mockFs.existsSync.mockReturnValue(false);

      const response = await request(app).post('/process').send({});

      expect(response.status).toBe(200);
      expect(response.body.results[0]).toMatchObject({
        sku: 'ERROR-SKU',
        error: 'Inventory error',
        mode: 'draft',
      });
    });

    it('should parse JSON error messages', async () => {
      const mockEntries = { entries: [] };
      const mockGroups = [
        {
          sku: 'JSON-ERROR',
          priceImageName: '10',
          main: { path_lower: '/ebay/test.jpg' },
          gallery: [],
        },
      ];
      const ebayError = { errors: [{ message: 'Invalid category' }] };
      mockListFolder.mockResolvedValue(mockEntries);
      mockGroupProductsFromDropbox.mockReturnValue(mockGroups);
      mockGetRawLink.mockResolvedValue('https://dropbox.com/raw/test.jpg');
      mockComputeEbayPrice.mockReturnValue(12.99);
      mockComputeFloorPrice.mockReturnValue(10.00);
      mockEnsureInventoryItem.mockResolvedValue(undefined);
      mockCreateOffer.mockRejectedValue(new Error(JSON.stringify(ebayError)));
      mockFs.existsSync.mockReturnValue(false);

      const response = await request(app).post('/process').send({});

      expect(response.status).toBe(200);
      expect(response.body.results[0].error).toEqual(ebayError);
    });

    it('should validate request body with Zod', async () => {
      const response = await request(app)
        .post('/process')
        .send({ mode: 'invalid-mode' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    it('should respect limit parameter', async () => {
      const mockEntries = { entries: [] };
      const mockGroups = Array(20).fill({
        sku: 'SKU-MANY',
        priceImageName: '10',
        main: { path_lower: '/ebay/item.jpg' },
        gallery: [],
      });
      mockListFolder.mockResolvedValue(mockEntries);
      mockGroupProductsFromDropbox.mockReturnValue(mockGroups);
      mockGetRawLink.mockResolvedValue('https://dropbox.com/raw/item.jpg');
      mockComputeEbayPrice.mockReturnValue(12.99);
      mockComputeFloorPrice.mockReturnValue(10.00);
      mockEnsureInventoryItem.mockResolvedValue(undefined);
      mockCreateOffer.mockResolvedValue({ offerId: 'offer-123' });
      mockFs.existsSync.mockReturnValue(false);

      const response = await request(app)
        .post('/process')
        .query({ limit: 5 })
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.count).toBeLessThanOrEqual(5);
    });

    it('should handle Dropbox listing errors', async () => {
      mockListFolder.mockRejectedValue(new Error('Dropbox authentication failed'));

      const response = await request(app).post('/process').send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Dropbox authentication failed');
    });

    it('should handle category map parse errors gracefully', async () => {
      const mockEntries = { entries: [] };
      const mockGroups = [
        {
          sku: 'BAD-MAP',
          priceImageName: '10',
          main: { path_lower: '/ebay/test.jpg' },
          gallery: [],
        },
      ];
      mockListFolder.mockResolvedValue(mockEntries);
      mockGroupProductsFromDropbox.mockReturnValue(mockGroups);
      mockGetRawLink.mockResolvedValue('https://dropbox.com/raw/test.jpg');
      mockComputeEbayPrice.mockReturnValue(12.99);
      mockComputeFloorPrice.mockReturnValue(10.00);
      mockEnsureInventoryItem.mockResolvedValue(undefined);
      mockCreateOffer.mockResolvedValue({ offerId: 'offer-123' });
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json');

      const response = await request(app).post('/process').send({});

      expect(response.status).toBe(200);
      // Should use default category when parse fails
      expect(mockCreateOffer).toHaveBeenCalledWith(
        'demo',
        'BAD-MAP',
        expect.objectContaining({ categoryId: '99' })
      );
    });
  });
});
