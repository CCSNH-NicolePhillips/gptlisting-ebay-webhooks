import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Mock dependencies before importing router
const mockEnsureEbayPrereqs = jest.fn();

jest.mock('../../src/services/ebay.js', () => ({
  ensureEbayPrereqs: mockEnsureEbayPrereqs,
}));

import { setupRouter } from '../../src/routes/setup.js';

describe('setupRouter', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(setupRouter);
    jest.clearAllMocks();
  });

  describe('POST /setup/ebay/bootstrap', () => {
    it('should successfully bootstrap eBay prerequisites', async () => {
      const mockResult = {
        paymentPolicyId: 'payment-123',
        returnPolicyId: 'return-456',
        fulfillmentPolicyId: 'fulfillment-789',
        merchantLocationKey: 'location-abc',
      };
      (mockEnsureEbayPrereqs as any).mockResolvedValue(mockResult);

      const response = await request(app).post('/setup/ebay/bootstrap');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true, ...mockResult });
      expect(mockEnsureEbayPrereqs).toHaveBeenCalledWith('demo', {});
    });

    it('should handle bootstrap errors', async () => {
      (mockEnsureEbayPrereqs as any).mockRejectedValue(
        new Error('eBay API authentication failed')
      );

      const response = await request(app).post('/setup/ebay/bootstrap');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ ok: false, error: 'eBay API authentication failed' });
    });

    it('should handle policy creation failures', async () => {
      (mockEnsureEbayPrereqs as any).mockRejectedValue(
        new Error('Failed to create payment policy')
      );

      const response = await request(app).post('/setup/ebay/bootstrap');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ ok: false, error: 'Failed to create payment policy' });
    });

    it('should handle location validation errors', async () => {
      (mockEnsureEbayPrereqs as any).mockRejectedValue(
        new Error('Invalid merchant location')
      );

      const response = await request(app).post('/setup/ebay/bootstrap');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ ok: false, error: 'Invalid merchant location' });
    });

    it('should handle network timeouts', async () => {
      (mockEnsureEbayPrereqs as any).mockRejectedValue(
        new Error('Request timeout after 30s')
      );

      const response = await request(app).post('/setup/ebay/bootstrap');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ ok: false, error: 'Request timeout after 30s' });
    });

    it('should handle eBay API rate limiting', async () => {
      (mockEnsureEbayPrereqs as any).mockRejectedValue(
        new Error('Rate limit exceeded')
      );

      const response = await request(app).post('/setup/ebay/bootstrap');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ ok: false, error: 'Rate limit exceeded' });
    });

    it('should handle non-Error exceptions', async () => {
      (mockEnsureEbayPrereqs as any).mockRejectedValue('String error');

      const response = await request(app).post('/setup/ebay/bootstrap');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ ok: false, error: 'String error' });
    });
  });
});
