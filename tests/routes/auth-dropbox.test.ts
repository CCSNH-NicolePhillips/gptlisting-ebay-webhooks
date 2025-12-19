import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Mock dependencies before importing router
const mockOauthStartUrl = jest.fn();
const mockStoreDropboxTokens = jest.fn();
const mockListFolder = jest.fn();

jest.mock('../../src/services/dropbox.js', () => ({
  oauthStartUrl: mockOauthStartUrl,
  storeDropboxTokens: mockStoreDropboxTokens,
  listFolder: mockListFolder,
}));

jest.mock('../../src/config.js', () => ({
  cfg: {
    dropbox: {
      appKey: 'test-key',
      appSecret: 'test-secret',
    },
  },
}));

import { dropboxAuthRouter } from '../../src/routes/auth-dropbox.js';

describe('dropboxAuthRouter', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(dropboxAuthRouter);
    jest.clearAllMocks();
  });

  describe('GET /auth/dropbox', () => {
    it('should redirect to Dropbox OAuth URL', async () => {
      const mockUrl = 'https://www.dropbox.com/oauth2/authorize?client_id=test';
      mockOauthStartUrl.mockReturnValue(mockUrl);

      const response = await request(app).get('/auth/dropbox');

      expect(response.status).toBe(302);
      expect(response.header.location).toBe(mockUrl);
      expect(mockOauthStartUrl).toHaveBeenCalled();
    });
  });

  describe('GET /auth/dropbox/callback', () => {
    it('should handle successful OAuth callback', async () => {
      const mockTokens = {
        access_token: 'test-token',
        refresh_token: 'refresh-token',
        scope: 'account_info files.metadata.read',
      };
      (mockStoreDropboxTokens as any).mockResolvedValue(mockTokens);

      const response = await request(app)
        .get('/auth/dropbox/callback')
        .query({ code: 'valid-code' });

      expect(response.status).toBe(200);
      expect(response.text).toContain('Dropbox connected');
      expect(response.text).toContain('account_info files.metadata.read');
      expect(mockStoreDropboxTokens).toHaveBeenCalledWith('demo', 'valid-code');
    });

    it('should return 400 when code is missing', async () => {
      const response = await request(app).get('/auth/dropbox/callback');

      expect(response.status).toBe(400);
      expect(response.text).toBe('Missing code');
      expect(mockStoreDropboxTokens).not.toHaveBeenCalled();
    });

    it('should handle invalid_grant error', async () => {
      (mockStoreDropboxTokens as any).mockRejectedValue(
        new Error('invalid_grant: code already used')
      );

      const response = await request(app)
        .get('/auth/dropbox/callback')
        .query({ code: 'expired-code' });

      expect(response.status).toBe(400);
      expect(response.text).toContain('authorization code is missing, expired, or already used');
      expect(response.text).toContain('restart the Dropbox connect flow');
    });

    it('should handle code does not exist error', async () => {
      (mockStoreDropboxTokens as any).mockRejectedValue(
        new Error("code doesn't exist")
      );

      const response = await request(app)
        .get('/auth/dropbox/callback')
        .query({ code: 'invalid-code' });

      expect(response.status).toBe(400);
      expect(response.text).toContain('authorization code is missing, expired, or already used');
    });

    it('should handle generic OAuth errors', async () => {
      (mockStoreDropboxTokens as any).mockRejectedValue(
        new Error('Network timeout')
      );

      const response = await request(app)
        .get('/auth/dropbox/callback')
        .query({ code: 'valid-code' });

      expect(response.status).toBe(500);
      expect(response.text).toContain('Token exchange failed: Network timeout');
    });

    it('should handle non-Error exceptions', async () => {
      (mockStoreDropboxTokens as any).mockRejectedValue('String error');

      const response = await request(app)
        .get('/auth/dropbox/callback')
        .query({ code: 'valid-code' });

      expect(response.status).toBe(500);
      expect(response.text).toContain('Token exchange failed: String error');
    });
  });

  describe('GET /me/dropbox/list', () => {
    it('should list Dropbox folder contents', async () => {
      const mockFolderData = {
        entries: [
          { name: 'image1.jpg', path_lower: '/ebay/image1.jpg' },
          { name: 'image2.jpg', path_lower: '/ebay/image2.jpg' },
        ],
        cursor: 'cursor-123',
        has_more: false,
      };
      (mockListFolder as any).mockResolvedValue(mockFolderData);

      const response = await request(app).get('/me/dropbox/list');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockFolderData);
      expect(mockListFolder).toHaveBeenCalledWith('demo', '/EBAY');
    });

    it('should handle list errors', async () => {
      (mockListFolder as any).mockRejectedValue(new Error('Folder not found'));

      const response = await request(app).get('/me/dropbox/list');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Folder not found' });
    });

    it('should handle network errors', async () => {
      (mockListFolder as any).mockRejectedValue(new Error('Connection refused'));

      const response = await request(app).get('/me/dropbox/list');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Connection refused' });
    });
  });
});
