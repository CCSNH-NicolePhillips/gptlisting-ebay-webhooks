import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock dependencies before importing handler
jest.mock('../../src/lib/_common.js', () => ({
  accessTokenFromRefresh: jest.fn(),
  tokenHosts: jest.fn(() => ({ apiHost: 'https://api.ebay.com' })),
}));

jest.mock('../../src/lib/_blobs.js', () => ({
  tokensStore: jest.fn(() => ({
    get: jest.fn(),
  })),
}));

jest.mock('../../src/lib/_auth.js', () => ({
  getBearerToken: jest.fn(),
  getJwtSubUnverified: jest.fn(),
  requireAuthVerified: jest.fn(),
  userScopedKey: jest.fn((sub, key) => `${sub}:${key}`),
}));

// Mock fetch globally
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

import { handler } from '../../netlify/functions/ebay-end-listing.js';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified } from '../../src/lib/_auth.js';
import type { HandlerEvent, HandlerContext } from '@netlify/functions';

const mockEvent = (overrides: Partial<HandlerEvent> = {}): HandlerEvent => ({
  rawUrl: 'https://example.com/.netlify/functions/ebay-end-listing',
  rawQuery: '',
  path: '/.netlify/functions/ebay-end-listing',
  httpMethod: 'POST',
  headers: { authorization: 'Bearer test-token' },
  multiValueHeaders: {},
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  body: null,
  isBase64Encoded: false,
  ...overrides,
});

const mockContext: HandlerContext = {
  callbackWaitsForEmptyEventLoop: true,
  functionName: 'ebay-end-listing',
  functionVersion: '1',
  invokedFunctionArn: '',
  memoryLimitInMB: '128',
  awsRequestId: 'test-request-id',
  logGroupName: '',
  logStreamName: '',
  getRemainingTimeInMillis: () => 10000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
};

describe('ebay-end-listing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getBearerToken as jest.Mock).mockReturnValue('test-bearer');
    (requireAuthVerified as jest.Mock).mockResolvedValue({ sub: 'user123' });
    (getJwtSubUnverified as jest.Mock).mockReturnValue('user123');
    (tokensStore as jest.Mock).mockReturnValue({
      get: jest.fn().mockResolvedValue({ refresh_token: 'test-refresh' }),
    });
    (accessTokenFromRefresh as jest.Mock).mockResolvedValue({ access_token: 'test-access-token' });
    (tokenHosts as jest.Mock).mockReturnValue({ apiHost: 'https://api.ebay.com' });
  });

  it('should reject non-POST requests', async () => {
    const event = mockEvent({ httpMethod: 'GET' });
    const result = await handler(event, mockContext);
    
    expect(result.statusCode).toBe(405);
    expect(JSON.parse(result.body!)).toEqual({ error: 'Method not allowed' });
  });

  it('should reject requests without auth', async () => {
    (getBearerToken as jest.Mock).mockReturnValue(null);
    (requireAuthVerified as jest.Mock).mockResolvedValue(null);
    (getJwtSubUnverified as jest.Mock).mockReturnValue(null);
    
    const event = mockEvent({ body: JSON.stringify({ itemId: '123' }) });
    const result = await handler(event, mockContext);
    
    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body!)).toEqual({ error: 'Unauthorized' });
  });

  it('should require itemId', async () => {
    const event = mockEvent({ body: JSON.stringify({}) });
    const result = await handler(event, mockContext);
    
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!)).toEqual({ error: 'Missing itemId' });
  });

  it('should require eBay connection', async () => {
    (tokensStore as jest.Mock).mockReturnValue({
      get: jest.fn().mockResolvedValue(null),
    });
    
    const event = mockEvent({ body: JSON.stringify({ itemId: '123456789' }) });
    const result = await handler(event, mockContext);
    
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!)).toEqual({ error: 'Connect eBay first' });
  });

  describe('Trading API (EndFixedPriceItem)', () => {
    it('should end listing successfully via Trading API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `<?xml version="1.0"?>
          <EndFixedPriceItemResponse>
            <Ack>Success</Ack>
            <EndTime>2025-12-25T12:00:00.000Z</EndTime>
          </EndFixedPriceItemResponse>`,
      } as Response);
      
      const event = mockEvent({
        body: JSON.stringify({
          itemId: '123456789',
          isInventoryListing: false,
        }),
      });
      
      const result = await handler(event, mockContext);
      
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body!);
      expect(body.ok).toBe(true);
      expect(body.itemId).toBe('123456789');
      expect(body.method).toBe('trading-api');
      
      // Verify the API was called correctly
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.ebay.com/ws/api.dll',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-EBAY-API-CALL-NAME': 'EndFixedPriceItem',
          }),
        })
      );
    });

    it('should handle already-ended listings gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `<?xml version="1.0"?>
          <EndFixedPriceItemResponse>
            <Ack>Failure</Ack>
            <Errors>
              <ErrorCode>1047</ErrorCode>
              <ShortMessage>Invalid item ID</ShortMessage>
              <LongMessage>The item is not active.</LongMessage>
            </Errors>
          </EndFixedPriceItemResponse>`,
      } as Response);
      
      const event = mockEvent({
        body: JSON.stringify({
          itemId: '123456789',
          isInventoryListing: false,
        }),
      });
      
      const result = await handler(event, mockContext);
      
      // Should treat as success since item is already ended
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body!);
      expect(body.ok).toBe(true);
      expect(body.note).toBe('Item was already ended');
    });

    it('should handle API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `<?xml version="1.0"?>
          <EndFixedPriceItemResponse>
            <Ack>Failure</Ack>
            <Errors>
              <ErrorCode>999</ErrorCode>
              <ShortMessage>Some error</ShortMessage>
              <LongMessage>Something went wrong with your request.</LongMessage>
            </Errors>
          </EndFixedPriceItemResponse>`,
      } as Response);
      
      const event = mockEvent({
        body: JSON.stringify({
          itemId: '123456789',
          isInventoryListing: false,
        }),
      });
      
      const result = await handler(event, mockContext);
      
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body!);
      expect(body.error).toBe('Something went wrong with your request.');
      expect(body.errorCode).toBe('999');
    });

    it('should use provided ending reason', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `<EndFixedPriceItemResponse><Ack>Success</Ack></EndFixedPriceItemResponse>`,
      } as Response);
      
      const event = mockEvent({
        body: JSON.stringify({
          itemId: '123456789',
          isInventoryListing: false,
          reason: 'LostOrBroken',
        }),
      });
      
      await handler(event, mockContext);
      
      const callBody = mockFetch.mock.calls[0][1]?.body as string;
      expect(callBody).toContain('<EndingReason>LostOrBroken</EndingReason>');
    });

    it('should default to NotAvailable for invalid reasons', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `<EndFixedPriceItemResponse><Ack>Success</Ack></EndFixedPriceItemResponse>`,
      } as Response);
      
      const event = mockEvent({
        body: JSON.stringify({
          itemId: '123456789',
          isInventoryListing: false,
          reason: 'InvalidReason',
        }),
      });
      
      await handler(event, mockContext);
      
      const callBody = mockFetch.mock.calls[0][1]?.body as string;
      expect(callBody).toContain('<EndingReason>NotAvailable</EndingReason>');
    });
  });

  describe('Inventory API', () => {
    it('should delete offer via Inventory API', async () => {
      // Mock DELETE offer
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);
      
      // Mock DELETE inventory item
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);
      
      const event = mockEvent({
        body: JSON.stringify({
          itemId: '123456789',
          sku: 'TEST-SKU-001',
          offerId: 'offer-123',
          isInventoryListing: true,
        }),
      });
      
      const result = await handler(event, mockContext);
      
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body!);
      expect(body.ok).toBe(true);
      expect(body.method).toBe('inventory-api');
      
      // Verify both DELETE calls were made
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(1,
        'https://api.ebay.com/sell/inventory/v1/offer/offer-123',
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(mockFetch).toHaveBeenNthCalledWith(2,
        'https://api.ebay.com/sell/inventory/v1/inventory_item/TEST-SKU-001',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('should skip inventory item deletion when deleteInventoryItem is false', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);
      
      const event = mockEvent({
        body: JSON.stringify({
          itemId: '123456789',
          sku: 'TEST-SKU-001',
          offerId: 'offer-123',
          isInventoryListing: true,
          deleteInventoryItem: false,
        }),
      });
      
      const result = await handler(event, mockContext);
      
      expect(result.statusCode).toBe(200);
      // Only one call (offer deletion)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle offer already deleted (404)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not found',
      } as Response);
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);
      
      const event = mockEvent({
        body: JSON.stringify({
          itemId: '123456789',
          sku: 'TEST-SKU-001',
          offerId: 'offer-123',
          isInventoryListing: true,
        }),
      });
      
      const result = await handler(event, mockContext);
      
      // 404 is treated as success (already deleted)
      expect(result.statusCode).toBe(200);
    });

    it('should handle offer deletion error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal server error',
      } as Response);
      
      const event = mockEvent({
        body: JSON.stringify({
          itemId: '123456789',
          sku: 'TEST-SKU-001',
          offerId: 'offer-123',
          isInventoryListing: true,
        }),
      });
      
      const result = await handler(event, mockContext);
      
      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body!);
      expect(body.error).toBe('Failed to delete offer');
    });

    it('should succeed even if inventory item deletion fails', async () => {
      // Offer deletion succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);
      
      // Inventory item deletion fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Failed',
      } as Response);
      
      const event = mockEvent({
        body: JSON.stringify({
          itemId: '123456789',
          sku: 'TEST-SKU-001',
          offerId: 'offer-123',
          isInventoryListing: true,
        }),
      });
      
      const result = await handler(event, mockContext);
      
      // Should still succeed - offer was deleted
      expect(result.statusCode).toBe(200);
    });

    it('should URL-encode SKU with special characters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);
      
      const event = mockEvent({
        body: JSON.stringify({
          itemId: '123456789',
          sku: 'TEST/SKU 001',
          offerId: 'offer-123',
          isInventoryListing: true,
        }),
      });
      
      await handler(event, mockContext);
      
      // SKU should be URL-encoded
      expect(mockFetch).toHaveBeenNthCalledWith(2,
        'https://api.ebay.com/sell/inventory/v1/inventory_item/TEST%2FSKU%20001',
        expect.anything()
      );
    });
  });
});
