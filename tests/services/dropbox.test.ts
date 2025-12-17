import { jest } from '@jest/globals';
import path from 'path';

// Mock dependencies before importing the service
const mockFetch = jest.fn() as any;
const mockFs = {
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
};

jest.mock('undici', () => ({
  fetch: mockFetch,
}));

jest.mock('fs', () => mockFs);

const mockConfig = {
  dataDir: '/mock/data',
  dropbox: {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'https://test.com/callback',
  },
};

jest.mock('../../src/config.js', () => ({
  cfg: mockConfig,
}));

// Import service after mocks are set up
import * as dropboxService from '../../src/services/dropbox.js';

describe('dropbox service', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock for readTokens (empty by default)
    mockFs.readFileSync.mockImplementation(() => {
      return JSON.stringify({
        testUser: {
          refresh_token: 'test-refresh-token',
          scope: 'test-scope',
        },
      });
    });
  });

  describe('oauthStartUrl', () => {
    it('should generate correct OAuth URL with all parameters', () => {
      const url = dropboxService.oauthStartUrl();

      expect(url).toContain('https://www.dropbox.com/oauth2/authorize');
      expect(url).toContain('response_type=code');
      expect(url).toContain('client_id=test-client-id');
      expect(url).toContain('redirect_uri=https%3A%2F%2Ftest.com%2Fcallback');
      expect(url).toContain('token_access_type=offline');
      expect(url).toContain('scope=files.metadata.read+files.content.read+sharing.write');
      expect(url).toContain('locale=');
    });
  });

  describe('storeDropboxTokens', () => {
    it('should exchange code for tokens and store them', async () => {
      // Mock empty token file
      mockFs.readFileSync.mockImplementation(() => JSON.stringify({}));

      // Mock token exchange response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          scope: 'files.metadata.read files.content.read',
        }),
      });

      const result = await dropboxService.storeDropboxTokens('newUser', 'auth-code-123');

      // Verify fetch was called with correct parameters
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.dropboxapi.com/oauth2/token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
      );

      const fetchBody = (mockFetch.mock.calls[0][1] as any).body as string;
      expect(fetchBody).toContain('code=auth-code-123');
      expect(fetchBody).toContain('grant_type=authorization_code');
      expect(fetchBody).toContain('client_id=test-client-id');
      expect(fetchBody).toContain('client_secret=test-client-secret');

      // Verify tokens were stored
      expect(mockFs.mkdirSync).toHaveBeenCalledWith('/mock/data', { recursive: true });
      expect(mockFs.writeFileSync).toHaveBeenCalled();

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const savedData = JSON.parse(writeCall[1] as string);
      expect(savedData.newUser.refresh_token).toBe('new-refresh-token');

      expect(result.access_token).toBe('new-access-token');
    });

    it('should preserve existing user tokens when adding new user', async () => {
      // Mock existing token file with one user
      mockFs.readFileSync.mockImplementation(() =>
        JSON.stringify({
          existingUser: {
            refresh_token: 'existing-refresh-token',
            scope: 'existing-scope',
          },
        })
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          scope: 'new-scope',
        }),
      });

      await dropboxService.storeDropboxTokens('newUser', 'auth-code');

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const savedData = JSON.parse(writeCall[1] as string);

      // Both users should exist
      expect(savedData.existingUser.refresh_token).toBe('existing-refresh-token');
      expect(savedData.newUser.refresh_token).toBe('new-refresh-token');
    });

    it('should throw error on failed token exchange', async () => {
      mockFs.readFileSync.mockImplementation(() => JSON.stringify({}));

      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'invalid_grant' }),
      });

      await expect(dropboxService.storeDropboxTokens('user', 'bad-code')).rejects.toThrow();
    });
  });

  describe('listFolder', () => {
    it('should list folder contents successfully', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'fresh-access-token' }),
      });

      // Mock list folder response
      const mockEntries = [
        { '.tag': 'file', name: 'image1.jpg', path_lower: '/photos/image1.jpg' },
        { '.tag': 'file', name: 'image2.jpg', path_lower: '/photos/image2.jpg' },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ entries: mockEntries, cursor: 'cursor-123', has_more: false }),
      });

      const result = await dropboxService.listFolder('testUser', '/photos');

      // Verify token refresh was called
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        'https://api.dropboxapi.com/oauth2/token',
        expect.anything()
      );

      // Verify list folder was called with correct auth
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'https://api.dropboxapi.com/2/files/list_folder',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer fresh-access-token',
            'Content-Type': 'application/json',
          }),
        })
      );

      const listBody = JSON.parse((mockFetch.mock.calls[1][1] as any).body as string);
      expect(listBody.path).toBe('/photos');
      expect(listBody.recursive).toBe(false);

      expect(result.entries).toEqual(mockEntries);
    });

    it('should throw error when user has no tokens', async () => {
      mockFs.readFileSync.mockImplementation(() => JSON.stringify({}));

      await expect(dropboxService.listFolder('unknownUser', '/photos')).rejects.toThrow(
        'Dropbox not connected for user unknownUser'
      );
    });

    it('should throw error on API failure', async () => {
      // Mock token refresh success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      });

      // Mock list folder failure
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: { '.tag': 'path', path: 'not_found' } }),
      });

      await expect(dropboxService.listFolder('testUser', '/nonexistent')).rejects.toThrow();
    });
  });

  describe('getRawLink', () => {
    it('should create shared link and convert to raw URL', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      });

      // Mock create shared link success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: 'https://www.dropbox.com/s/abc123/photo.jpg?dl=0',
          name: 'photo.jpg',
        }),
      });

      const result = await dropboxService.getRawLink('testUser', '/photos/photo.jpg');

      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        })
      );

      // Verify URL was converted from ?dl=0 to ?raw=1
      expect(result).toBe('https://www.dropbox.com/s/abc123/photo.jpg?raw=1');
    });

    it('should handle existing shared link by fetching from list', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      // Mock create failure (already exists)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error_summary: 'shared_link_already_exists/metadata/...',
        }),
      });

      // Mock list shared links success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          links: [
            {
              url: 'https://www.dropbox.com/s/existing123/photo.jpg?dl=0',
              name: 'photo.jpg',
            },
          ],
        }),
      });

      const result = await dropboxService.getRawLink('testUser', '/photos/photo.jpg');

      // Verify fallback to list shared links
      expect(mockFetch).toHaveBeenNthCalledWith(
        3,
        'https://api.dropboxapi.com/2/sharing/list_shared_links',
        expect.objectContaining({
          method: 'POST',
        })
      );

      const listBody = JSON.parse((mockFetch.mock.calls[2][1] as any).body as string);
      expect(listBody.path).toBe('/photos/photo.jpg');
      expect(listBody.direct_only).toBe(true);

      expect(result).toBe('https://www.dropbox.com/s/existing123/photo.jpg?raw=1');
    });

    it('should throw error when shared link exists but list fails', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      // Mock create failure (already exists)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error_summary: 'shared_link_already_exists/metadata/...',
        }),
      });

      // Mock list shared links failure
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'access_denied' }),
      });

      await expect(dropboxService.getRawLink('testUser', '/file.jpg')).rejects.toThrow();
    });

    it('should throw error when shared link exists but no links returned', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      // Mock create failure (already exists)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error_summary: 'shared_link_already_exists/...',
        }),
      });

      // Mock list shared links success but empty
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ links: [] }),
      });

      await expect(dropboxService.getRawLink('testUser', '/file.jpg')).rejects.toThrow();
    });

    it('should throw error on non-duplicate create failure', async () => {
      // Mock token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token' }),
      } as any);

      // Mock create failure (different error)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error_summary: 'invalid_access_token/...',
        }),
      });

      await expect(dropboxService.getRawLink('testUser', '/file.jpg')).rejects.toThrow();

      // Should not attempt to list shared links
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('token refresh with update', () => {
    it('should update refresh token if new one is provided', async () => {
      mockFs.readFileSync.mockImplementation(() =>
        JSON.stringify({
          testUser: { refresh_token: 'old-refresh-token', scope: 'scope' },
        })
      );

      // Mock token refresh that returns new refresh token
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
        }),
      });

      // Mock successful list folder call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ entries: [] }),
      });

      await dropboxService.listFolder('testUser', '/test');

      // Verify tokens were updated
      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const savedData = JSON.parse(writeCall[1] as string);
      expect(savedData.testUser.refresh_token).toBe('new-refresh-token');
    });

    it('should not update tokens if no new refresh token provided', async () => {
      mockFs.readFileSync.mockImplementation(() =>
        JSON.stringify({
          testUser: { refresh_token: 'existing-refresh-token', scope: 'scope' },
        })
      );

      // Mock token refresh WITHOUT new refresh token
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'access-token-only',
          // No refresh_token field
        }),
      });

      // Mock successful list folder call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ entries: [] }),
      });

      await dropboxService.listFolder('testUser', '/test');

      // Verify tokens were NOT written (no writeFileSync call)
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });
  });
});
