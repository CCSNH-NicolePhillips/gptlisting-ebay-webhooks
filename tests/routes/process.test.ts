import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
type ListFolderFn = typeof import('../../src/services/dropbox.js')['listFolder'];
type GetRawLinkFn = typeof import('../../src/services/dropbox.js')['getRawLink'];
type EnsureInventoryItemFn = typeof import('../../src/services/ebay.js')['ensureInventoryItem'];
type CreateOfferFn = typeof import('../../src/services/ebay.js')['createOffer'];
type PublishOfferFn = typeof import('../../src/services/ebay.js')['publishOffer'];
type EnsureEbayPrereqsFn = typeof import('../../src/services/ebay.js')['ensureEbayPrereqs'];
type GroupProductsFromDropboxFn = typeof import('../../src/utils/grouping.js')['groupProductsFromDropbox'];
type ComputeEbayPriceFn = typeof import('../../src/utils/pricing.js')['computeEbayPrice'];
type ComputeFloorPriceFn = typeof import('../../src/utils/pricing.js')['computeFloorPrice'];
type Entry = { name: string; path_lower: string };

// Mock dependencies before importing router
const mockListFolder: jest.MockedFunction<ListFolderFn> = jest.fn();
const mockGetRawLink: jest.MockedFunction<GetRawLinkFn> = jest.fn();
const mockEnsureInventoryItem: jest.MockedFunction<EnsureInventoryItemFn> = jest.fn();
const mockCreateOffer: jest.MockedFunction<CreateOfferFn> = jest.fn();
const mockPublishOffer: jest.MockedFunction<PublishOfferFn> = jest.fn();
const mockEnsureEbayPrereqs: jest.MockedFunction<EnsureEbayPrereqsFn> = jest.fn();
const mockGroupProductsFromDropbox: jest.MockedFunction<GroupProductsFromDropboxFn> = jest.fn();
const mockComputeEbayPrice: jest.MockedFunction<ComputeEbayPriceFn> = jest.fn();
const mockComputeFloorPrice: jest.MockedFunction<ComputeFloorPriceFn> = jest.fn();
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

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
  };
});

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

import fs from 'fs';
import { processRouter } from '../../src/routes/process.js';
const mockFs = fs as jest.Mocked<typeof fs>;

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
          main: { name: 'product1-front.jpg', path_lower: '/ebay/product1-front.jpg' } as Entry,
          gallery: [{ name: 'product1-back.jpg', path_lower: '/ebay/product1-back.jpg' } as Entry],
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
          main: { name: 'item.jpg', path_lower: '/ebay/item.jpg' } as Entry,
          gallery: [] as Entry[],
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
          main: { name: 'book.jpg', path_lower: '/ebay/book.jpg' } as Entry,
          gallery: [] as Entry[],
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
        { sku: 'NO-IMAGES', priceImageName: '0', main: null, gallery: [] as Entry[] },
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
          main: { name: 'error.jpg', path_lower: '/ebay/error.jpg' } as Entry,
          gallery: [] as Entry[],
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
          main: { name: 'test.jpg', path_lower: '/ebay/test.jpg' } as Entry,
          gallery: [] as Entry[],
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
        main: { name: 'item.jpg', path_lower: '/ebay/item.jpg' } as Entry,
        gallery: [] as Entry[],
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
          main: { name: 'test.jpg', path_lower: '/ebay/test.jpg' } as Entry,
          gallery: [] as Entry[],
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
