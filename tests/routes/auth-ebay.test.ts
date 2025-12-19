import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Mock dependencies before importing router
const mockBuildEbayAuthUrl = jest.fn();
const mockExchangeAuthCode = jest.fn();
const mockSaveEbayTokens = jest.fn();

jest.mock('../../src/services/ebay.js', () => ({
  buildEbayAuthUrl: mockBuildEbayAuthUrl,
  exchangeAuthCode: mockExchangeAuthCode,
  saveEbayTokens: mockSaveEbayTokens,
}));

jest.mock('../../src/config.js', () => ({
  cfg: {
    ebay: {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      ruName: 'test-ru-name',
    },
  },
}));

import { ebayAuthRouter } from '../../src/routes/auth-ebay.js';

describe('ebayAuthRouter', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(ebayAuthRouter);
    jest.clearAllMocks();
  });

  describe('GET /auth/ebay', () => {
    it('should redirect to eBay OAuth URL', async () => {
      const mockUrl = 'https://auth.ebay.com/oauth2/authorize?client_id=test';
      mockBuildEbayAuthUrl.mockReturnValue(mockUrl);

      const response = await request(app).get('/auth/ebay');

      expect(response.status).toBe(302);
      expect(response.header.location).toBe(mockUrl);
      expect(mockBuildEbayAuthUrl).toHaveBeenCalled();
    });

    it('should include scopes in OAuth URL', async () => {
      const mockUrl = 'https://auth.ebay.com/oauth2/authorize?scope=https://api.ebay.com/oauth/api_scope';
      mockBuildEbayAuthUrl.mockReturnValue(mockUrl);

      await request(app).get('/auth/ebay');

      expect(mockBuildEbayAuthUrl).toHaveBeenCalled();
    });
  });

  describe('GET /auth/ebay/callback', () => {
    it('should handle successful OAuth callback', async () => {
      const mockTokens = {
        access_token: 'ebay-access-token',
        refresh_token: 'ebay-refresh-token',
        expires_in: 7200,
      };
      (mockExchangeAuthCode as any).mockResolvedValue(mockTokens);
      (mockSaveEbayTokens as any).mockResolvedValue(undefined);

      const response = await request(app)
        .get('/auth/ebay/callback')
        .query({ code: 'valid-code' });

      expect(response.status).toBe(302);
      expect(response.header.location).toBe('/connected/ebay');
      expect(mockExchangeAuthCode).toHaveBeenCalledWith('valid-code');
      expect(mockSaveEbayTokens).toHaveBeenCalledWith('demo', mockTokens);
    });

    it('should return 400 when code is missing', async () => {
      const response = await request(app).get('/auth/ebay/callback');

      expect(response.status).toBe(400);
      expect(response.text).toBe('Missing code');
      expect(mockExchangeAuthCode).not.toHaveBeenCalled();
      expect(mockSaveEbayTokens).not.toHaveBeenCalled();
    });

    it('should handle token exchange errors', async () => {
      (mockExchangeAuthCode as any).mockRejectedValue(
        new Error('Invalid authorization code')
      );

      const response = await request(app)
        .get('/auth/ebay/callback')
        .query({ code: 'invalid-code' });

      expect(response.status).toBe(500);
      expect(response.text).toContain('eBay callback error: Invalid authorization code');
      expect(mockSaveEbayTokens).not.toHaveBeenCalled();
    });

    it('should handle token save errors', async () => {
      const mockTokens = {
        access_token: 'ebay-access-token',
        refresh_token: 'ebay-refresh-token',
        expires_in: 7200,
      };
      (mockExchangeAuthCode as any).mockResolvedValue(mockTokens);
      (mockSaveEbayTokens as any).mockRejectedValue(
        new Error('Database connection failed')
      );

      const response = await request(app)
        .get('/auth/ebay/callback')
        .query({ code: 'valid-code' });

      expect(response.status).toBe(500);
      expect(response.text).toContain('eBay callback error: Database connection failed');
    });

    it('should handle expired authorization codes', async () => {
      (mockExchangeAuthCode as any).mockRejectedValue(
        new Error('Authorization code expired')
      );

      const response = await request(app)
        .get('/auth/ebay/callback')
        .query({ code: 'expired-code' });

      expect(response.status).toBe(500);
      expect(response.text).toContain('eBay callback error: Authorization code expired');
    });

    it('should handle non-Error exceptions', async () => {
      (mockExchangeAuthCode as any).mockRejectedValue('String error');

      const response = await request(app)
        .get('/auth/ebay/callback')
        .query({ code: 'valid-code' });

      expect(response.status).toBe(500);
      expect(response.text).toContain('eBay callback error: String error');
    });

    it('should handle network timeouts', async () => {
      (mockExchangeAuthCode as any).mockRejectedValue(
        new Error('Network request timeout')
      );

      const response = await request(app)
        .get('/auth/ebay/callback')
        .query({ code: 'valid-code' });

      expect(response.status).toBe(500);
      expect(response.text).toContain('eBay callback error: Network request timeout');
    });
  });
});
