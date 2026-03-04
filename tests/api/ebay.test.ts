/**
 * Express API — eBay offer/listing routes
 *
 * GET    /api/ebay/offers/:offerId  (get-offer)
 * GET    /api/ebay/offers           (list-offers)
 * DELETE /api/ebay/offers/:offerId  (delete-offer)
 * POST   /api/ebay/offers/:offerId/publish  (publish-offer)
 * POST   /api/ebay/listings/end     (end-listing)
 */

import http from 'http';
import request from 'supertest';
import { jest } from '@jest/globals';

jest.mock('../../src/lib/auth-user.js', () => ({
  requireUserAuth: jest.fn(),
  requireUserAuthFull: jest.fn(),
}));

jest.mock('../../src/services/ebay-offers.service.js', () => ({
  getOffer: jest.fn(),
  listOffers: jest.fn(),
  deleteOffer: jest.fn(),
  publishOffer: jest.fn(),
  EbayApiError: class EbayApiError extends Error {
    statusCode: number;
    body: unknown;
    constructor(statusCode: number, body: unknown) {
      super(`eBay API error ${statusCode}`);
      this.name = 'EbayApiError';
      this.statusCode = statusCode;
      this.body = body;
    }
  },
  EbayPublishError: class EbayPublishError extends Error {
    statusCode: number;
    body: unknown;
    constructor(statusCode: number, body: unknown) {
      super(`eBay publish error ${statusCode}`);
      this.name = 'EbayPublishError';
      this.statusCode = statusCode;
      this.body = body;
    }
  },
}));

jest.mock('../../src/services/ebay-listings.service.js', () => ({
  endListing: jest.fn(),
}));

jest.mock('../../src/services/ebay-inventory.service.js', () => ({
  getInventoryItem: jest.fn(),
}));

jest.mock('../../src/services/ebay-taxonomy.service.js', () => ({
  getCategorySuggestions: jest.fn(),
}));

jest.mock('../../src/services/ebay-active-item.service.js', () => ({
  getActiveItem: jest.fn(),
}));

jest.mock('../../src/lib/ebay-client.js', () => ({
  getEbayClient: jest.fn(),
  EbayNotConnectedError: class EbayNotConnectedError extends Error {
    statusCode = 400;
    constructor() {
      super('Connect eBay first');
      this.name = 'EbayNotConnectedError';
    }
  },
}));

jest.mock('../../packages/core/src/services/ebay/locations.js', () => ({
  listLocations: jest.fn(),
  getUserLocation: jest.fn(),
  setUserLocation: jest.fn(),
  EbayApiError: class EbayApiError extends Error {
    statusCode: number;
    body: unknown;
    constructor(statusCode: number, body: unknown) {
      super(`eBay API error ${statusCode}`);
      this.name = 'EbayApiError';
      this.statusCode = statusCode;
      this.body = body;
    }
  },
}));

jest.mock('../../packages/core/src/services/ebay/active-trading.js', () => ({
  listActiveListings: jest.fn(),
}));

jest.mock('../../packages/core/src/services/ebay/update-listing.js', () => ({
  updateActiveListing: jest.fn(),
  UpdateListingError: class UpdateListingError extends Error {
    statusCode: number;
    detail?: unknown;
    constructor(msg: string, statusCode: number, detail?: unknown) {
      super(msg);
      this.name = 'UpdateListingError';
      this.statusCode = statusCode;
      this.detail = detail;
    }
  },
}));

let server: http.Server;
let mockRequireUserAuth: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetOffer: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockListOffers: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockDeleteOffer: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockPublishOffer: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockEndListing: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetInventoryItem: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetCategorySuggestions: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetActiveItem: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockListLocations: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetUserLocation: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockSetUserLocation: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockListActiveListings: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockUpdateActiveListing: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

const MOCK_USER = { userId: 'auth0|ebay-user' };

const MOCK_OFFER = {
  offerId: 'off-123',
  sku: 'SKU-001',
  status: 'UNPUBLISHED',
  pricingSummary: { price: { value: '9.99', currency: 'USD' } },
};

const MOCK_LIST_RESULT = {
  ok: true,
  total: 1,
  offers: [MOCK_OFFER],
  elapsed: 200,
};

beforeAll(async () => {
  const { app } = await import('../../apps/api/src/index.js');
  server = app.listen(0);

  const authModule = await import('../../src/lib/auth-user.js');
  mockRequireUserAuth = authModule.requireUserAuth as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const offersService = await import('../../src/services/ebay-offers.service.js');
  mockGetOffer = offersService.getOffer as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;
  mockListOffers = offersService.listOffers as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;
  mockDeleteOffer = offersService.deleteOffer as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;
  mockPublishOffer = offersService.publishOffer as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const listingsService = await import('../../src/services/ebay-listings.service.js');
  mockEndListing = listingsService.endListing as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const inventoryService = await import('../../src/services/ebay-inventory.service.js');
  mockGetInventoryItem = inventoryService.getInventoryItem as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const taxonomyService = await import('../../src/services/ebay-taxonomy.service.js');
  mockGetCategorySuggestions = taxonomyService.getCategorySuggestions as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const activeItemService = await import('../../src/services/ebay-active-item.service.js');
  mockGetActiveItem = activeItemService.getActiveItem as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const locationsService = await import('../../packages/core/src/services/ebay/locations.js');
  mockListLocations = locationsService.listLocations as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockGetUserLocation = locationsService.getUserLocation as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockSetUserLocation = locationsService.setUserLocation as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const activeTradingService = await import('../../packages/core/src/services/ebay/active-trading.js');
  mockListActiveListings = activeTradingService.listActiveListings as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const updateListingService = await import('../../packages/core/src/services/ebay/update-listing.js');
  mockUpdateActiveListing = updateListingService.updateActiveListing as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
});

beforeEach(() => jest.clearAllMocks());

afterAll((done) => { server.close(done); });

// ── GET /api/ebay/offers ──────────────────────────────────────────────────────

describe('GET /api/ebay/offers', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).get('/api/ebay/offers');
    expect(res.status).toBe(401);
  });

  it('returns 200 with list on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockListOffers.mockResolvedValue(MOCK_LIST_RESULT);

    const res = await request(server)
      .get('/api/ebay/offers?status=UNPUBLISHED&limit=10')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, total: 1, offers: expect.any(Array) });
    expect(mockListOffers).toHaveBeenCalledWith(MOCK_USER.userId, {
      sku: undefined,
      status: 'UNPUBLISHED',
      limit: 10,
      offset: undefined,
    });
  });

  it('returns 400 when eBay is not connected', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { EbayNotConnectedError } = await import('../../src/lib/ebay-client.js');
    mockListOffers.mockRejectedValue(new (EbayNotConnectedError as any)());

    const res = await request(server)
      .get('/api/ebay/offers')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Connect eBay/i);
  });

  it('returns 500 on service error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockListOffers.mockRejectedValue(new Error('Redis unavailable'));

    const res = await request(server)
      .get('/api/ebay/offers')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(500);
  });
});

// ── GET /api/ebay/offers/:offerId ─────────────────────────────────────────────

describe('GET /api/ebay/offers/:offerId', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).get('/api/ebay/offers/off-123');
    expect(res.status).toBe(401);
  });

  it('returns 200 with offer on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetOffer.mockResolvedValue({ offer: MOCK_OFFER });

    const res = await request(server)
      .get('/api/ebay/offers/off-123')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, offer: expect.objectContaining({ offerId: 'off-123' }) });
    expect(mockGetOffer).toHaveBeenCalledWith(MOCK_USER.userId, 'off-123');
  });

  it('forwards eBay API error status', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { EbayApiError } = await import('../../src/services/ebay-offers.service.js');
    mockGetOffer.mockRejectedValue(new (EbayApiError as any)(404, { error: 'Not found' }));

    const res = await request(server)
      .get('/api/ebay/offers/off-999')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(404);
  });
});

// ── DELETE /api/ebay/offers/:offerId ──────────────────────────────────────────

describe('DELETE /api/ebay/offers/:offerId', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).delete('/api/ebay/offers/off-123');
    expect(res.status).toBe(401);
  });

  it('returns 200 with deleted id on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockDeleteOffer.mockResolvedValue({ ok: true, deleted: 'off-123' });

    const res = await request(server)
      .delete('/api/ebay/offers/off-123')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, deleted: 'off-123' });
    expect(mockDeleteOffer).toHaveBeenCalledWith(MOCK_USER.userId, 'off-123');
  });

  it('returns 400 when eBay not connected', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { EbayNotConnectedError } = await import('../../src/lib/ebay-client.js');
    mockDeleteOffer.mockRejectedValue(new (EbayNotConnectedError as any)());

    const res = await request(server)
      .delete('/api/ebay/offers/off-123')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(400);
  });
});

// ── POST /api/ebay/offers/:offerId/publish ────────────────────────────────────

describe('POST /api/ebay/offers/:offerId/publish', () => {
  const MOCK_PUBLISH_RESULT = {
    ok: true,
    result: { listingId: 'listing-789' },
    promotion: null,
    autoPrice: null,
  };

  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).post('/api/ebay/offers/off-123/publish').send({});
    expect(res.status).toBe(401);
  });

  it('returns 200 with result on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockPublishOffer.mockResolvedValue(MOCK_PUBLISH_RESULT);

    const res = await request(server)
      .post('/api/ebay/offers/off-123/publish')
      .set('Authorization', 'Bearer tok')
      .send({ condition: 1000 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, result: { listingId: 'listing-789' } });
    expect(mockPublishOffer).toHaveBeenCalledWith(MOCK_USER.userId, 'off-123', 1000);
  });

  it('forwards publish error with 4xx status', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { EbayPublishError } = await import('../../src/services/ebay-offers.service.js');
    mockPublishOffer.mockRejectedValue(
      new (EbayPublishError as any)(422, { errors: [{ errorId: 25020 }] }),
    );

    const res = await request(server)
      .post('/api/ebay/offers/off-123/publish')
      .set('Authorization', 'Bearer tok')
      .send({});

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ ok: false, error: 'publish failed' });
  });

  it('returns 500 on unexpected error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockPublishOffer.mockRejectedValue(new Error('Something went wrong'));

    const res = await request(server)
      .post('/api/ebay/offers/off-123/publish')
      .set('Authorization', 'Bearer tok')
      .send({});

    expect(res.status).toBe(500);
  });
});

// ── POST /api/ebay/listings/end ───────────────────────────────────────────────

describe('POST /api/ebay/listings/end', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).post('/api/ebay/listings/end').send({});
    expect(res.status).toBe(401);
  });

  it('returns 400 when itemId is missing (Trading API path)', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);

    const res = await request(server)
      .post('/api/ebay/listings/end')
      .set('Authorization', 'Bearer tok')
      .send({ isInventoryListing: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/itemId/i);
  });

  it('returns 400 when offerId is missing (Inventory API path)', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);

    const res = await request(server)
      .post('/api/ebay/listings/end')
      .set('Authorization', 'Bearer tok')
      .send({ isInventoryListing: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/offerId/i);
  });

  it('returns 200 on happy path (Trading API)', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockEndListing.mockResolvedValue({ ok: true, itemId: '12345', method: 'trading-api' });

    const res = await request(server)
      .post('/api/ebay/listings/end')
      .set('Authorization', 'Bearer tok')
      .send({ itemId: '12345', isInventoryListing: false, reason: 'NotAvailable' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, method: 'trading-api' });
    expect(mockEndListing).toHaveBeenCalledWith(
      MOCK_USER.userId,
      expect.objectContaining({ itemId: '12345', isInventoryListing: false }),
    );
  });

  it('returns 200 on happy path (Inventory API)', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockEndListing.mockResolvedValue({ ok: true, itemId: undefined, method: 'inventory-api' });

    const res = await request(server)
      .post('/api/ebay/listings/end')
      .set('Authorization', 'Bearer tok')
      .send({ offerId: 'off-123', sku: 'SKU-001', isInventoryListing: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, method: 'inventory-api' });
  });

  it('returns 400 when eBay not connected', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { EbayNotConnectedError } = await import('../../src/lib/ebay-client.js');
    mockEndListing.mockRejectedValue(new (EbayNotConnectedError as any)());

    const res = await request(server)
      .post('/api/ebay/listings/end')
      .set('Authorization', 'Bearer tok')
      .send({ itemId: '12345' });

    expect(res.status).toBe(400);
  });

  it('returns 500 on unexpected error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockEndListing.mockRejectedValue(new Error('Connection reset'));

    const res = await request(server)
      .post('/api/ebay/listings/end')
      .set('Authorization', 'Bearer tok')
      .send({ itemId: '12345' });

    expect(res.status).toBe(500);
  });
});

// ── GET /api/ebay/inventory/:sku ──────────────────────────────────────────────

describe('GET /api/ebay/inventory/:sku', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).get('/api/ebay/inventory/SKU-001');
    expect(res.status).toBe(401);
  });

  it('returns 200 with inventory item on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const mockItem = { sku: 'SKU-001', condition: 'NEW', product: { title: 'Test Product' } };
    mockGetInventoryItem.mockResolvedValue({ ok: true, item: mockItem });

    const res = await request(server)
      .get('/api/ebay/inventory/SKU-001')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, item: expect.objectContaining({ sku: 'SKU-001' }) });
    expect(mockGetInventoryItem).toHaveBeenCalledWith(MOCK_USER.userId, 'SKU-001');
  });

  it('returns 400 when eBay not connected', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { EbayNotConnectedError } = await import('../../src/lib/ebay-client.js');
    mockGetInventoryItem.mockRejectedValue(new (EbayNotConnectedError as any)());

    const res = await request(server)
      .get('/api/ebay/inventory/SKU-001')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Connect eBay/i);
  });

  it('returns 500 on upstream error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetInventoryItem.mockRejectedValue(new Error('Redis unreachable'));

    const res = await request(server)
      .get('/api/ebay/inventory/SKU-001')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(500);
  });
});

// ── GET /api/ebay/category-suggestions ───────────────────────────────────────

describe('GET /api/ebay/category-suggestions', () => {
  it('returns 400 when q is missing', async () => {
    const res = await request(server).get('/api/ebay/category-suggestions');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing q/i);
  });

  it('returns 200 with suggestions on happy path', async () => {
    const mockResult = {
      ok: true,
      treeId: '0',
      suggestions: [{ categoryId: '11116', categoryName: 'Vitamins', categoryPath: 'Health > Vitamins' }],
    };
    mockGetCategorySuggestions.mockResolvedValue(mockResult);

    const res = await request(server).get('/api/ebay/category-suggestions?q=vitamins');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, treeId: '0', suggestions: expect.any(Array) });
    expect(mockGetCategorySuggestions).toHaveBeenCalledWith('vitamins');
  });

  it('returns 500 on service error', async () => {
    mockGetCategorySuggestions.mockRejectedValue(new Error('eBay taxonomy unavailable'));

    const res = await request(server).get('/api/ebay/category-suggestions?q=books');

    expect(res.status).toBe(500);
  });
});

// ── GET /api/ebay/active-listings/:itemId ─────────────────────────────────────

describe('GET /api/ebay/active-listings/:itemId', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).get('/api/ebay/active-listings/112233');
    expect(res.status).toBe(401);
  });

  it('returns 200 with item on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const mockItem = {
      itemId: '112233',
      sku: 'SKU-001',
      isInventoryListing: true,
      title: 'Test Item',
      price: '9.99',
      images: [],
      aspects: {},
    };
    mockGetActiveItem.mockResolvedValue({ ok: true, item: mockItem });

    const res = await request(server)
      .get('/api/ebay/active-listings/112233')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, item: expect.objectContaining({ itemId: '112233' }) });
    expect(mockGetActiveItem).toHaveBeenCalledWith(MOCK_USER.userId, '112233');
  });

  it('returns 400 when eBay not connected', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { EbayNotConnectedError } = await import('../../src/lib/ebay-client.js');
    mockGetActiveItem.mockRejectedValue(new (EbayNotConnectedError as any)());

    const res = await request(server)
      .get('/api/ebay/active-listings/112233')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(400);
  });

  it('returns 500 on upstream error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetActiveItem.mockRejectedValue(new Error('Trading API timeout'));

    const res = await request(server)
      .get('/api/ebay/active-listings/112233')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(500);
  });
});

// ── GET /api/ebay/locations ───────────────────────────────────────────────────

describe('GET /api/ebay/locations', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).get('/api/ebay/locations');
    expect(res.status).toBe(401);
  });

  it('returns 200 with location list on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockListLocations.mockResolvedValue([{ key: 'WH-MAIN', isDefault: true }]);
    const res = await request(server)
      .get('/api/ebay/locations')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.locations).toHaveLength(1);
  });

  it('returns 500 on upstream error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockListLocations.mockRejectedValue(new Error('eBay API down'));
    const res = await request(server)
      .get('/api/ebay/locations')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(500);
  });
});

// ── GET /api/ebay/locations/user ─────────────────────────────────────────────

describe('GET /api/ebay/locations/user', () => {
  it('returns 200 with saved key', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetUserLocation.mockResolvedValue('WH-MAIN');
    const res = await request(server)
      .get('/api/ebay/locations/user')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body.merchantLocationKey).toBe('WH-MAIN');
  });

  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).get('/api/ebay/locations/user');
    expect(res.status).toBe(401);
  });
});

// ── POST /api/ebay/locations/user ────────────────────────────────────────────

describe('POST /api/ebay/locations/user', () => {
  it('returns 400 when merchantLocationKey missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .post('/api/ebay/locations/user')
      .set('Authorization', 'Bearer tok')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/merchantLocationKey/i);
  });

  it('returns 200 on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockSetUserLocation.mockResolvedValue(undefined);
    const res = await request(server)
      .post('/api/ebay/locations/user')
      .set('Authorization', 'Bearer tok')
      .send({ merchantLocationKey: 'WH-MAIN' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockSetUserLocation).toHaveBeenCalledWith(MOCK_USER.userId, 'WH-MAIN');
  });
});

// ── GET /api/ebay/listings/active ────────────────────────────────────────────

describe('GET /api/ebay/listings/active', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).get('/api/ebay/listings/active');
    expect(res.status).toBe(401);
  });

  it('returns 200 with active listings on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockListActiveListings.mockResolvedValue({ count: 2, offers: [{ itemId: '1' }, { itemId: '2' }] });
    const res = await request(server)
      .get('/api/ebay/listings/active')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.offers).toHaveLength(2);
  });

  it('returns 500 on upstream error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockListActiveListings.mockRejectedValue(new Error('Trading API timeout'));
    const res = await request(server)
      .get('/api/ebay/listings/active')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(500);
  });
});

// ── PUT /api/ebay/listings/:id ───────────────────────────────────────────────

describe('PUT /api/ebay/listings/:id', () => {
  it('returns 400 when itemId missing from both param and body', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .put('/api/ebay/listings/')
      .set('Authorization', 'Bearer tok')
      .send({ title: 'New Title' });
    expect(res.status).toBe(404); // no route match
  });

  it('returns 200 on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockUpdateActiveListing.mockResolvedValue({ ok: true, updated: true, path: 'inventory' });
    const res = await request(server)
      .put('/api/ebay/listings/item-123')
      .set('Authorization', 'Bearer tok')
      .send({ title: 'Updated Title', price: 19.99 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 404 when listing not found', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { UpdateListingError } = await import('../../packages/core/src/services/ebay/update-listing.js');
    mockUpdateActiveListing.mockRejectedValue(new (UpdateListingError as any)('Not found', 404));
    const res = await request(server)
      .put('/api/ebay/listings/item-bad')
      .set('Authorization', 'Bearer tok')
      .send({ title: 'T' });
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockUpdateActiveListing.mockRejectedValue(new Error('Connection reset'));
    const res = await request(server)
      .put('/api/ebay/listings/item-x')
      .set('Authorization', 'Bearer tok')
      .send({ title: 'T' });
    expect(res.status).toBe(500);
  });
});
