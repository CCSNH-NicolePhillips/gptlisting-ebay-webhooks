// tests/ingestion/dropbox.test.ts
import { DropboxAdapter, validateDropboxListPayload } from '../../src/ingestion/dropbox';
import { IngestError, IngestErrorCode } from '../../src/ingestion/types';
import type { IngestRequest } from '../../src/ingestion/types';

// Mock dependencies
jest.mock('../../src/lib/mime.js', () => ({
  guessMime: jest.fn((filename: string) => {
    if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) return 'image/jpeg';
    if (filename.endsWith('.png')) return 'image/png';
    return 'application/octet-stream';
  }),
}));

jest.mock('../../src/lib/storage.js', () => ({
  copyToStaging: jest.fn() as jest.Mock<any>,
  getStagedUrl: jest.fn() as jest.Mock<any>,
}));

jest.mock('node-fetch');

import { guessMime } from '../../src/lib/mime.js';
import { copyToStaging, getStagedUrl } from '../../src/lib/storage.js';

describe('DropboxAdapter', () => {
  const mockGuessMime = guessMime as jest.Mock<any>;
  const mockCopyToStaging = copyToStaging as jest.Mock<any>;
  const mockGetStagedUrl = getStagedUrl as jest.Mock<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn() as jest.Mock<any>;
    process.env.DROPBOX_CLIENT_ID = 'test-client-id';
    process.env.DROPBOX_CLIENT_SECRET = 'test-client-secret';
  });

  afterEach(() => {
    delete process.env.DROPBOX_CLIENT_ID;
    delete process.env.DROPBOX_CLIENT_SECRET;
  });

  describe('list', () => {
    it('should list and stage Dropbox files successfully', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'dropbox',
        payload: {
          folderPath: '/Photos/Products',
          refreshToken: 'refresh_token_123',
        },
      };

      // Mock token refresh
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'access_token_xyz' }),
      } as unknown as Response);

      // Mock list_folder
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          entries: [
            {
              '.tag': 'file',
              name: 'product1.jpg',
              path_lower: '/photos/products/product1.jpg',
              path_display: '/Photos/Products/product1.jpg',
              id: 'id:abc123',
              client_modified: '2023-11-01T10:00:00Z',
              size: 1024000,
            },
            {
              '.tag': 'file',
              name: 'product2.png',
              path_lower: '/photos/products/product2.png',
              path_display: '/Photos/Products/product2.png',
              id: 'id:def456',
              server_modified: '2023-11-02T12:00:00Z',
              size: 2048000,
            },
          ],
          has_more: false,
        }),
      } as unknown as Response);

      // Mock get_temporary_link (2 times)
      (global.fetch as jest.Mock<any>)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({ link: 'https://dl.dropboxusercontent.com/temp/product1.jpg' }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({ link: 'https://dl.dropboxusercontent.com/temp/product2.png' }),
        } as unknown as Response);

      mockCopyToStaging
        .mockResolvedValueOnce('staging/user123/product1.jpg')
        .mockResolvedValueOnce('staging/user123/product2.png');

      mockGetStagedUrl
        .mockResolvedValueOnce('https://storage.example.com/staging/user123/product1.jpg')
        .mockResolvedValueOnce('https://storage.example.com/staging/user123/product2.png');

      const result = await DropboxAdapter.list(req);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 'id:abc123',
        name: 'product1.jpg',
        mime: 'image/jpeg',
        bytes: 1024000,
        stagedUrl: 'https://storage.example.com/staging/user123/product1.jpg',
      });
      expect(result[0].meta).toMatchObject({
        sourcePath: '/Photos/Products/product1.jpg',
        sourceId: 'id:abc123',
        dropboxPath: '/photos/products/product1.jpg',
        stagingKey: 'staging/user123/product1.jpg',
      });

      expect(result[1]).toMatchObject({
        id: 'id:def456',
        name: 'product2.png',
        mime: 'image/png',
        bytes: 2048000,
      });
    });

    it('should handle pagination with has_more', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'dropbox',
        payload: {
          folderPath: '/Photos',
          refreshToken: 'refresh_token_123',
        },
      };

      // Mock token refresh
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'access_token_xyz' }),
      } as unknown as Response);

      // Mock list_folder (first page)
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          entries: [
            {
              '.tag': 'file',
              name: 'img1.jpg',
              path_lower: '/photos/img1.jpg',
              id: 'id:img1',
              size: 1000,
            },
          ],
          has_more: true,
          cursor: 'cursor_abc123',
        }),
      } as unknown as Response);

      // Mock list_folder/continue (second page)
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          entries: [
            {
              '.tag': 'file',
              name: 'img2.jpg',
              path_lower: '/photos/img2.jpg',
              id: 'id:img2',
              size: 2000,
            },
          ],
          has_more: false,
        }),
      } as unknown as Response);

      // Mock get_temporary_link (2 times)
      (global.fetch as jest.Mock<any>)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({ link: 'https://dl.dropbox.com/temp/img1.jpg' }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({ link: 'https://dl.dropbox.com/temp/img2.jpg' }),
        } as unknown as Response);

      mockCopyToStaging.mockResolvedValue('staging/key');
      mockGetStagedUrl.mockResolvedValue('https://storage.example.com/staged');

      const result = await DropboxAdapter.list(req);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('img1.jpg');
      expect(result[1].name).toBe('img2.jpg');

      // Verify list_folder/continue was called
      expect((global.fetch as jest.Mock<any>).mock.calls[2][0]).toBe(
        'https://api.dropboxapi.com/2/files/list_folder/continue'
      );
    });

    it('should filter out non-image files', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'dropbox',
        payload: {
          folderPath: '/Files',
          refreshToken: 'refresh_token_123',
        },
      };

      // Mock token refresh
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'access_token_xyz' }),
      } as unknown as Response);

      // Mock list_folder with mixed files
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          entries: [
            {
              '.tag': 'file',
              name: 'image.jpg',
              path_lower: '/files/image.jpg',
              id: 'id:img',
              size: 1000,
            },
            {
              '.tag': 'file',
              name: 'document.pdf',
              path_lower: '/files/document.pdf',
              id: 'id:pdf',
              size: 5000,
            },
            {
              '.tag': 'file',
              name: 'data.csv',
              path_lower: '/files/data.csv',
              id: 'id:csv',
              size: 2000,
            },
          ],
          has_more: false,
        }),
      } as unknown as Response);

      // Mock get_temporary_link (only for image)
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ link: 'https://dl.dropbox.com/temp/image.jpg' }),
      } as unknown as Response);

      mockCopyToStaging.mockResolvedValue('staging/key');
      mockGetStagedUrl.mockResolvedValue('https://storage.example.com/staged');

      const result = await DropboxAdapter.list(req);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('image.jpg');
    });

    it('should support skipStaging flag', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'dropbox',
        payload: {
          folderPath: '/Photos',
          refreshToken: 'refresh_token_123',
          skipStaging: true,
        },
      };

      // Mock token refresh
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'access_token_xyz' }),
      } as unknown as Response);

      // Mock list_folder
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          entries: [
            {
              '.tag': 'file',
              name: 'photo.jpg',
              path_lower: '/photos/photo.jpg',
              id: 'id:photo',
              size: 1000,
            },
          ],
          has_more: false,
        }),
      } as unknown as Response);

      // Mock get_temporary_link
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ link: 'https://dl.dropbox.com/temp/photo.jpg' }),
      } as unknown as Response);

      const result = await DropboxAdapter.list(req);

      expect(result).toHaveLength(1);
      expect(result[0].stagedUrl).toBe('https://dl.dropbox.com/temp/photo.jpg');
      expect(result[0].meta?.stagingKey).toBeUndefined();
      expect(mockCopyToStaging).not.toHaveBeenCalled();
      expect(mockGetStagedUrl).not.toHaveBeenCalled();
    });

    it('should throw IngestError when folderPath is missing', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'dropbox',
        payload: {
          refreshToken: 'refresh_token_123',
        },
      };

      await expect(DropboxAdapter.list(req)).rejects.toThrow(IngestError);
      await expect(DropboxAdapter.list(req)).rejects.toMatchObject({
        code: IngestErrorCode.INVALID_SOURCE,
        message: expect.stringContaining('folderPath required'),
      });
    });

    it('should throw IngestError when refreshToken is missing', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'dropbox',
        payload: {
          folderPath: '/Photos',
        },
      };

      await expect(DropboxAdapter.list(req)).rejects.toThrow(IngestError);
      await expect(DropboxAdapter.list(req)).rejects.toMatchObject({
        code: IngestErrorCode.AUTH_FAILED,
        message: expect.stringContaining('refresh token required'),
      });
    });

    it('should handle token refresh failure', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'dropbox',
        payload: {
          folderPath: '/Photos',
          refreshToken: 'invalid_token',
        },
      };

      // Mock failed token refresh
      (global.fetch as jest.Mock<any>).mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: 'invalid_grant' }),
      } as unknown as Response);

      await expect(DropboxAdapter.list(req)).rejects.toThrow(IngestError);
      await expect(DropboxAdapter.list(req)).rejects.toMatchObject({
        code: IngestErrorCode.AUTH_FAILED,
        message: expect.stringContaining('token refresh failed'),
      });
    });

    it('should handle Dropbox API errors', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'dropbox',
        payload: {
          folderPath: '/NonExistentFolder',
          refreshToken: 'refresh_token_123',
        },
      };

      // Mock token refresh
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'access_token_xyz' }),
      } as unknown as Response);

      // Mock list_folder error
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ error: { '.tag': 'path', path: { '.tag': 'not_found' } } }),
      } as unknown as Response);

      await expect(DropboxAdapter.list(req)).rejects.toThrow();
    });

    it('should return empty array when folder has no images', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'dropbox',
        payload: {
          folderPath: '/EmptyFolder',
          refreshToken: 'refresh_token_123',
        },
      };

      // Mock token refresh
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'access_token_xyz' }),
      } as unknown as Response);

      // Mock list_folder with no entries
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          entries: [],
          has_more: false,
        }),
      } as unknown as Response);

      const result = await DropboxAdapter.list(req);

      expect(result).toEqual([]);
    });

    it('should continue processing when individual file fails', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'dropbox',
        payload: {
          folderPath: '/Photos',
          refreshToken: 'refresh_token_123',
        },
      };

      // Mock token refresh
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'access_token_xyz' }),
      } as unknown as Response);

      // Mock list_folder
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          entries: [
            {
              '.tag': 'file',
              name: 'good.jpg',
              path_lower: '/photos/good.jpg',
              id: 'id:good',
              size: 1000,
            },
            {
              '.tag': 'file',
              name: 'bad.jpg',
              path_lower: '/photos/bad.jpg',
              id: 'id:bad',
              size: 2000,
            },
          ],
          has_more: false,
        }),
      } as unknown as Response);

      // Mock get_temporary_link - first succeeds, second fails
      (global.fetch as jest.Mock<any>)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({ link: 'https://dl.dropbox.com/temp/good.jpg' }),
        } as unknown as Response)
        .mockRejectedValueOnce(new Error('Network error'));

      mockCopyToStaging.mockResolvedValue('staging/key');
      mockGetStagedUrl.mockResolvedValue('https://storage.example.com/staged');

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await DropboxAdapter.list(req);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('good.jpg');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to process bad.jpg'),
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });

    it('should handle staging failure', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'dropbox',
        payload: {
          folderPath: '/Photos',
          refreshToken: 'refresh_token_123',
        },
      };

      // Mock token refresh
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'access_token_xyz' }),
      } as unknown as Response);

      // Mock list_folder
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          entries: [
            {
              '.tag': 'file',
              name: 'photo.jpg',
              path_lower: '/photos/photo.jpg',
              id: 'id:photo',
              size: 1000,
            },
          ],
          has_more: false,
        }),
      } as unknown as Response);

      // Mock get_temporary_link
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ link: 'https://dl.dropbox.com/temp/photo.jpg' }),
      } as unknown as Response);

      // Mock staging failure
      mockCopyToStaging.mockRejectedValue(new Error('Storage quota exceeded'));

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await DropboxAdapter.list(req);

      expect(result).toHaveLength(0);
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should pass jobId to staging when provided', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'dropbox',
        payload: {
          folderPath: '/Photos',
          refreshToken: 'refresh_token_123',
          jobId: 'job456',
        },
      };

      // Mock token refresh
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'access_token_xyz' }),
      } as unknown as Response);

      // Mock list_folder
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          entries: [
            {
              '.tag': 'file',
              name: 'photo.jpg',
              path_lower: '/photos/photo.jpg',
              id: 'id:photo',
              size: 1000,
            },
          ],
          has_more: false,
        }),
      } as unknown as Response);

      // Mock get_temporary_link
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ link: 'https://dl.dropbox.com/temp/photo.jpg' }),
      } as unknown as Response);

      mockCopyToStaging.mockResolvedValue('staging/key');
      mockGetStagedUrl.mockResolvedValue('https://storage.example.com/staged');

      await DropboxAdapter.list(req);

      expect(mockCopyToStaging).toHaveBeenCalledWith(
        'https://dl.dropbox.com/temp/photo.jpg',
        'user123',
        'photo.jpg',
        'image/jpeg',
        'job456'
      );
    });

    it('should handle various image extensions', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'dropbox',
        payload: {
          folderPath: '/Photos',
          refreshToken: 'refresh_token_123',
          skipStaging: true,
        },
      };

      // Mock token refresh
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'access_token_xyz' }),
      } as unknown as Response);

      // Mock list_folder with various image types
      (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          entries: [
            { '.tag': 'file', name: 'photo.jpg', path_lower: '/photos/photo.jpg', id: 'id:1', size: 1000 },
            { '.tag': 'file', name: 'image.jpeg', path_lower: '/photos/image.jpeg', id: 'id:2', size: 1000 },
            { '.tag': 'file', name: 'pic.png', path_lower: '/photos/pic.png', id: 'id:3', size: 1000 },
            { '.tag': 'file', name: 'graphic.gif', path_lower: '/photos/graphic.gif', id: 'id:4', size: 1000 },
            { '.tag': 'file', name: 'web.webp', path_lower: '/photos/web.webp', id: 'id:5', size: 1000 },
            { '.tag': 'file', name: 'raw.tiff', path_lower: '/photos/raw.tiff', id: 'id:6', size: 1000 },
          ],
          has_more: false,
        }),
      } as unknown as Response);

      // Mock get_temporary_link for each
      for (let i = 0; i < 6; i++) {
        (global.fetch as jest.Mock<any>).mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({ link: `https://dl.dropbox.com/temp/file${i}` }),
        } as unknown as Response);
      }

      const result = await DropboxAdapter.list(req);

      expect(result).toHaveLength(6);
      expect(result.map((f: any) => f.name)).toEqual([
        'photo.jpg',
        'image.jpeg',
        'pic.png',
        'graphic.gif',
        'web.webp',
        'raw.tiff',
      ]);
    });
  });
});

describe('validateDropboxListPayload', () => {
  it('should validate correct payload', () => {
    const payload = {
      folderPath: '/Photos/Products',
      refreshToken: 'refresh_token_123',
    };

    const result = validateDropboxListPayload(payload);

    expect(result).toEqual({
      folderPath: '/Photos/Products',
      refreshToken: 'refresh_token_123',
      cursor: undefined,
      skipStaging: undefined,
    });
  });

  it('should trim whitespace from strings', () => {
    const payload = {
      folderPath: '  /Photos/Products  ',
      refreshToken: '  refresh_token_123  ',
    };

    const result = validateDropboxListPayload(payload);

    expect(result.folderPath).toBe('/Photos/Products');
    expect(result.refreshToken).toBe('refresh_token_123');
  });

  it('should include optional fields when present', () => {
    const payload = {
      folderPath: '/Photos',
      refreshToken: 'token123',
      cursor: 'cursor_abc',
      skipStaging: true,
    };

    const result = validateDropboxListPayload(payload);

    expect(result).toEqual({
      folderPath: '/Photos',
      refreshToken: 'token123',
      cursor: 'cursor_abc',
      skipStaging: true,
    });
  });

  it('should throw IngestError for null payload', () => {
    expect(() => validateDropboxListPayload(null)).toThrow(IngestError);
    expect(() => validateDropboxListPayload(null)).toThrow(
      expect.objectContaining({
        code: IngestErrorCode.INVALID_SOURCE,
        message: expect.stringContaining('Invalid payload'),
      })
    );
  });

  it('should throw IngestError for non-object payload', () => {
    expect(() => validateDropboxListPayload('not an object')).toThrow(IngestError);
    expect(() => validateDropboxListPayload(123)).toThrow(IngestError);
  });

  it('should throw IngestError for missing folderPath', () => {
    const payload = {
      refreshToken: 'token123',
    };

    expect(() => validateDropboxListPayload(payload)).toThrow(IngestError);
    expect(() => validateDropboxListPayload(payload)).toThrow(
      expect.objectContaining({
        code: IngestErrorCode.INVALID_SOURCE,
        message: expect.stringContaining('folderPath must be'),
      })
    );
  });

  it('should throw IngestError for empty folderPath', () => {
    const payload = {
      folderPath: '   ',
      refreshToken: 'token123',
    };

    expect(() => validateDropboxListPayload(payload)).toThrow(IngestError);
  });

  it('should throw IngestError for missing refreshToken', () => {
    const payload = {
      folderPath: '/Photos',
    };

    expect(() => validateDropboxListPayload(payload)).toThrow(IngestError);
    expect(() => validateDropboxListPayload(payload)).toThrow(
      expect.objectContaining({
        code: IngestErrorCode.AUTH_FAILED,
        message: expect.stringContaining('refreshToken required'),
      })
    );
  });

  it('should throw IngestError for empty refreshToken', () => {
    const payload = {
      folderPath: '/Photos',
      refreshToken: '   ',
    };

    expect(() => validateDropboxListPayload(payload)).toThrow(IngestError);
  });

  it('should throw IngestError for non-string folderPath', () => {
    const payload = {
      folderPath: 123,
      refreshToken: 'token123',
    };

    expect(() => validateDropboxListPayload(payload)).toThrow(IngestError);
  });

  it('should throw IngestError for non-string refreshToken', () => {
    const payload = {
      folderPath: '/Photos',
      refreshToken: 123,
    };

    expect(() => validateDropboxListPayload(payload)).toThrow(IngestError);
  });
});
