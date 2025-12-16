// tests/ingestion/local.test.ts
import { LocalAdapter, validateLocalListPayload, validateLocalStagePayload, uploadFilesServerSide } from '../../src/ingestion/local';
import { IngestError, IngestErrorCode } from '../../src/ingestion/types';
import type { IngestRequest } from '../../src/ingestion/types';

// Mock dependencies
jest.mock('../../src/lib/mime.js', () => ({
  guessMime: jest.fn((filename: string) => {
    if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) return 'image/jpeg';
    if (filename.endsWith('.png')) return 'image/png';
    return 'application/octet-stream';
  }),
  hasImageExtension: jest.fn((filename: string) => {
    return /\.(jpg|jpeg|png|gif|webp|heic|heif|bmp|tiff?)$/i.test(filename);
  }),
}));

jest.mock('../../src/lib/storage.js', () => ({
  getStagedUrl: jest.fn() as jest.Mock<any>,
  generatePresignedUploads: jest.fn() as jest.Mock<any>,
  createStorageClient: jest.fn() as jest.Mock<any>,
  getStagingConfig: jest.fn() as jest.Mock<any>,
  generateStagingKey: jest.fn() as jest.Mock<any>,
}));

jest.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: jest.fn(),
}));

import { guessMime, hasImageExtension } from '../../src/lib/mime.js';
import { getStagedUrl, generatePresignedUploads, createStorageClient, getStagingConfig, generateStagingKey } from '../../src/lib/storage.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';

describe('LocalAdapter', () => {
  const mockGetStagedUrl = getStagedUrl as jest.Mock<any>;
  const mockGeneratePresignedUploads = generatePresignedUploads as jest.Mock<any>;
  const mockGuessMime = guessMime as jest.Mock<any>;
  const mockHasImageExtension = hasImageExtension as jest.Mock<any>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('list', () => {
    it('should list uploaded files from staging keys', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'local',
        payload: {
          keys: [
            'staging/user123/photo1.jpg',
            'staging/user123/photo2.png',
          ],
        },
      };

      mockHasImageExtension.mockReturnValue(true);
      mockGetStagedUrl
        .mockResolvedValueOnce('https://storage.example.com/staging/user123/photo1.jpg')
        .mockResolvedValueOnce('https://storage.example.com/staging/user123/photo2.png');

      const result = await LocalAdapter.list(req);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 'staging/user123/photo1.jpg',
        name: 'photo1.jpg',
        mime: 'image/jpeg',
        stagedUrl: 'https://storage.example.com/staging/user123/photo1.jpg',
      });
      expect(result[0].meta).toMatchObject({
        sourcePath: 'staging/user123/photo1.jpg',
        sourceId: 'staging/user123/photo1.jpg',
      });
      expect(result[0].meta?.uploadedAt).toBeDefined();

      expect(result[1]).toMatchObject({
        id: 'staging/user123/photo2.png',
        name: 'photo2.png',
        mime: 'image/png',
        stagedUrl: 'https://storage.example.com/staging/user123/photo2.png',
      });
    });

    it('should skip non-image files', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'local',
        payload: {
          keys: [
            'staging/user123/photo.jpg',
            'staging/user123/document.pdf',
            'staging/user123/image.png',
          ],
        },
      };

      mockHasImageExtension
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);

      mockGetStagedUrl
        .mockResolvedValueOnce('https://storage.example.com/staging/user123/photo.jpg')
        .mockResolvedValueOnce('https://storage.example.com/staging/user123/image.png');

      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      const result = await LocalAdapter.list(req);

      expect(result).toHaveLength(2);
      expect(result.map((f: any) => f.name)).toEqual(['photo.jpg', 'image.png']);
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping non-image file: document.pdf'));

      consoleLogSpy.mockRestore();
    });

    it('should throw IngestError when keys is missing', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'local',
        payload: {},
      };

      await expect(LocalAdapter.list(req)).rejects.toThrow(IngestError);
      await expect(LocalAdapter.list(req)).rejects.toMatchObject({
        code: IngestErrorCode.INVALID_SOURCE,
        message: expect.stringContaining('requires keys array'),
      });
    });

    it('should throw IngestError when keys is empty array', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'local',
        payload: {
          keys: [],
        },
      };

      await expect(LocalAdapter.list(req)).rejects.toThrow(IngestError);
      await expect(LocalAdapter.list(req)).rejects.toMatchObject({
        code: IngestErrorCode.INVALID_SOURCE,
        message: expect.stringContaining('requires keys array'),
      });
    });

    it('should throw IngestError when keys is not an array', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'local',
        payload: {
          keys: 'not-an-array',
        },
      };

      await expect(LocalAdapter.list(req)).rejects.toThrow(IngestError);
    });

    it('should extract filename from key path', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'local',
        payload: {
          keys: ['staging/user123/subfolder/nested/image.jpg'],
        },
      };

      mockHasImageExtension.mockReturnValue(true);
      mockGetStagedUrl.mockResolvedValue('https://storage.example.com/staged');

      const result = await LocalAdapter.list(req);

      expect(result[0].name).toBe('image.jpg');
    });

    it('should handle keys without path separators', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'local',
        payload: {
          keys: ['simplekey.jpg'],
        },
      };

      mockHasImageExtension.mockReturnValue(true);
      mockGetStagedUrl.mockResolvedValue('https://storage.example.com/staged');

      const result = await LocalAdapter.list(req);

      expect(result[0].name).toBe('simplekey.jpg');
    });
  });

  describe('stage', () => {
    it('should generate presigned URLs for file uploads', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'local',
        payload: {
          fileCount: 3,
          filenames: ['photo1.jpg', 'photo2.png', 'photo3.jpg'],
          mimeHints: ['image/jpeg', 'image/png', 'image/jpeg'],
        },
      };

      mockGeneratePresignedUploads.mockResolvedValue([
        { key: 'staging/user123/photo1.jpg', url: 'https://presigned-url-1', fields: {} },
        { key: 'staging/user123/photo2.png', url: 'https://presigned-url-2', fields: {} },
        { key: 'staging/user123/photo3.jpg', url: 'https://presigned-url-3', fields: {} },
      ]);

      const result = await LocalAdapter.stage!(req);

      expect(result.uploads).toHaveLength(3);
      expect(mockGeneratePresignedUploads).toHaveBeenCalledWith(
        'user123',
        [
          { name: 'photo1.jpg', mime: 'image/jpeg' },
          { name: 'photo2.png', mime: 'image/png' },
          { name: 'photo3.jpg', mime: 'image/jpeg' },
        ],
        undefined
      );
    });

    it('should use default filenames when not provided', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'local',
        payload: {
          fileCount: 2,
        },
      };

      mockGeneratePresignedUploads.mockResolvedValue([
        { key: 'staging/user123/image-1.jpg', url: 'https://presigned-url-1', fields: {} },
        { key: 'staging/user123/image-2.jpg', url: 'https://presigned-url-2', fields: {} },
      ]);

      await LocalAdapter.stage!(req);

      expect(mockGeneratePresignedUploads).toHaveBeenCalledWith(
        'user123',
        [
          { name: 'image-1.jpg', mime: 'image/jpeg' },
          { name: 'image-2.jpg', mime: 'image/jpeg' },
        ],
        undefined
      );
    });

    it('should use guessMime for missing mimeHints', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'local',
        payload: {
          fileCount: 2,
          filenames: ['photo.jpg', 'image.png'],
        },
      };

      mockGeneratePresignedUploads.mockResolvedValue([]);

      await LocalAdapter.stage!(req);

      expect(mockGuessMime).toHaveBeenCalledWith('photo.jpg');
      expect(mockGuessMime).toHaveBeenCalledWith('image.png');
    });

    it('should pass jobId when provided', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'local',
        payload: {
          fileCount: 1,
          jobId: 'job456',
        },
      };

      mockGeneratePresignedUploads.mockResolvedValue([]);

      await LocalAdapter.stage!(req);

      expect(mockGeneratePresignedUploads).toHaveBeenCalledWith(
        'user123',
        expect.any(Array),
        'job456'
      );
    });

    it('should throw IngestError when fileCount is missing', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'local',
        payload: {},
      };

      await expect(LocalAdapter.stage!(req)).rejects.toThrow(IngestError);
      await expect(LocalAdapter.stage!(req)).rejects.toMatchObject({
        code: IngestErrorCode.INVALID_SOURCE,
        message: expect.stringContaining('fileCount required'),
      });
    });

    it('should throw IngestError when fileCount is zero', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'local',
        payload: {
          fileCount: 0,
        },
      };

      await expect(LocalAdapter.stage!(req)).rejects.toThrow(IngestError);
    });

    it('should throw IngestError when fileCount exceeds limit', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'local',
        payload: {
          fileCount: 250,
        },
      };

      await expect(LocalAdapter.stage!(req)).rejects.toThrow(IngestError);
      await expect(LocalAdapter.stage!(req)).rejects.toMatchObject({
        code: IngestErrorCode.QUOTA_EXCEEDED,
        message: expect.stringContaining('Maximum 200 files per batch'),
      });
    });

    it('should enforce exactly MAX_FILES (200) limit', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'local',
        payload: {
          fileCount: 200,
        },
      };

      mockGeneratePresignedUploads.mockResolvedValue([]);

      await expect(LocalAdapter.stage!(req)).resolves.toBeDefined();
    });

    it('should handle partial filenames and mimeHints arrays', async () => {
      const req: IngestRequest = {
        userId: 'user123',
        source: 'local',
        payload: {
          fileCount: 4,
          filenames: ['custom1.jpg', 'custom2.png'],
          mimeHints: ['image/jpeg'],
        },
      };

      mockGeneratePresignedUploads.mockResolvedValue([]);

      await LocalAdapter.stage!(req);

      expect(mockGeneratePresignedUploads).toHaveBeenCalledWith(
        'user123',
        [
          { name: 'custom1.jpg', mime: 'image/jpeg' },
          { name: 'custom2.png', mime: 'image/png' },
          { name: 'image-3.jpg', mime: 'image/jpeg' },
          { name: 'image-4.jpg', mime: 'image/jpeg' },
        ],
        undefined
      );
    });
  });
});

describe('validateLocalListPayload', () => {
  it('should validate correct payload', () => {
    const payload = {
      keys: ['staging/user123/photo1.jpg', 'staging/user123/photo2.png'],
    };

    const result = validateLocalListPayload(payload);

    expect(result).toEqual(['staging/user123/photo1.jpg', 'staging/user123/photo2.png']);
  });

  it('should throw IngestError for null payload', () => {
    expect(() => validateLocalListPayload(null)).toThrow(IngestError);
    expect(() => validateLocalListPayload(null)).toThrow(
      expect.objectContaining({
        code: IngestErrorCode.INVALID_SOURCE,
        message: expect.stringContaining('Invalid payload'),
      })
    );
  });

  it('should throw IngestError for non-object payload', () => {
    expect(() => validateLocalListPayload('not an object')).toThrow(IngestError);
    expect(() => validateLocalListPayload(123)).toThrow(IngestError);
  });

  it('should throw IngestError when keys is not an array', () => {
    expect(() => validateLocalListPayload({ keys: 'not-array' })).toThrow(IngestError);
    expect(() => validateLocalListPayload({ keys: 'not-array' })).toThrow(
      expect.objectContaining({
        code: IngestErrorCode.INVALID_SOURCE,
        message: expect.stringContaining('keys must be an array'),
      })
    );
  });

  it('should throw IngestError when keys is empty', () => {
    expect(() => validateLocalListPayload({ keys: [] })).toThrow(IngestError);
    expect(() => validateLocalListPayload({ keys: [] })).toThrow(
      expect.objectContaining({
        code: IngestErrorCode.INVALID_SOURCE,
        message: expect.stringContaining('keys array cannot be empty'),
      })
    );
  });

  it('should throw IngestError when keys contains non-strings', () => {
    expect(() => validateLocalListPayload({ keys: ['valid', 123, 'also-valid'] })).toThrow(IngestError);
    expect(() => validateLocalListPayload({ keys: ['valid', 123, 'also-valid'] })).toThrow(
      expect.objectContaining({
        code: IngestErrorCode.INVALID_SOURCE,
        message: expect.stringContaining('All keys must be strings'),
      })
    );
  });

  it('should accept single key', () => {
    const result = validateLocalListPayload({ keys: ['single-key.jpg'] });
    expect(result).toEqual(['single-key.jpg']);
  });
});

describe('validateLocalStagePayload', () => {
  it('should validate correct payload', () => {
    const payload = {
      fileCount: 5,
      mimeHints: ['image/jpeg', 'image/png'],
      filenames: ['photo1.jpg', 'photo2.png'],
    };

    const result = validateLocalStagePayload(payload);

    expect(result).toEqual({
      fileCount: 5,
      mimeHints: ['image/jpeg', 'image/png'],
      filenames: ['photo1.jpg', 'photo2.png'],
    });
  });

  it('should accept minimal payload with only fileCount', () => {
    const payload = {
      fileCount: 3,
    };

    const result = validateLocalStagePayload(payload);

    expect(result).toEqual({
      fileCount: 3,
      mimeHints: undefined,
      filenames: undefined,
    });
  });

  it('should throw IngestError for null payload', () => {
    expect(() => validateLocalStagePayload(null)).toThrow(IngestError);
    expect(() => validateLocalStagePayload(null)).toThrow(
      expect.objectContaining({
        code: IngestErrorCode.INVALID_SOURCE,
        message: expect.stringContaining('Invalid payload'),
      })
    );
  });

  it('should throw IngestError for non-object payload', () => {
    expect(() => validateLocalStagePayload('not an object')).toThrow(IngestError);
    expect(() => validateLocalStagePayload(123)).toThrow(IngestError);
  });

  it('should throw IngestError when fileCount is missing', () => {
    expect(() => validateLocalStagePayload({})).toThrow(IngestError);
    expect(() => validateLocalStagePayload({})).toThrow(
      expect.objectContaining({
        code: IngestErrorCode.INVALID_SOURCE,
        message: expect.stringContaining('fileCount must be a positive number'),
      })
    );
  });

  it('should throw IngestError when fileCount is zero', () => {
    expect(() => validateLocalStagePayload({ fileCount: 0 })).toThrow(IngestError);
  });

  it('should throw IngestError when fileCount is negative', () => {
    expect(() => validateLocalStagePayload({ fileCount: -5 })).toThrow(IngestError);
  });

  it('should throw IngestError when fileCount is not a number', () => {
    expect(() => validateLocalStagePayload({ fileCount: '10' })).toThrow(IngestError);
  });
});

describe('uploadFilesServerSide', () => {
  const mockCreateStorageClient = createStorageClient as jest.Mock<any>;
  const mockGetStagingConfig = getStagingConfig as jest.Mock<any>;
  const mockGenerateStagingKey = generateStagingKey as jest.Mock<any>;
  const mockPutObjectCommand = PutObjectCommand as unknown as jest.Mock<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockGetStagingConfig.mockReturnValue({
      bucket: 'test-bucket',
      accountId: 'test-account',
      retentionHours: 48,
    });

    const mockSend = jest.fn().mockResolvedValue({});
    mockCreateStorageClient.mockReturnValue({
      send: mockSend,
    });

    mockGenerateStagingKey.mockImplementation((userId: string, filename: string) => {
      return `staging/${userId}/${filename}`;
    });
  });

  it('should upload files and return keys', async () => {
    const files = [
      { name: 'photo1.jpg', mime: 'image/jpeg', data: Buffer.from('fake-image-1').toString('base64') },
      { name: 'photo2.png', mime: 'image/png', data: Buffer.from('fake-image-2').toString('base64') },
    ];

    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

    const result = await uploadFilesServerSide('user123', files);

    expect(result).toEqual([
      'staging/user123/photo1.jpg',
      'staging/user123/photo2.png',
    ]);

    expect(mockPutObjectCommand).toHaveBeenCalledTimes(2);
    expect(mockPutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'test-bucket',
        Key: 'staging/user123/photo1.jpg',
        ContentType: 'image/jpeg',
      })
    );

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Starting upload of'), 2, 'files');
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Upload complete!'), 2, 'files uploaded');

    consoleLogSpy.mockRestore();
  });

  it('should decode base64 data correctly', async () => {
    const imageData = 'test-image-data';
    const base64Data = Buffer.from(imageData).toString('base64');
    
    const files = [
      { name: 'photo.jpg', mime: 'image/jpeg', data: base64Data },
    ];

    const mockSend = jest.fn().mockResolvedValue({});
    mockCreateStorageClient.mockReturnValue({ send: mockSend });

    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

    await uploadFilesServerSide('user123', files);

    expect(mockPutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Body: Buffer.from(imageData),
      })
    );

    consoleLogSpy.mockRestore();
  });

  it('should include metadata in upload', async () => {
    const files = [
      { name: 'photo.jpg', mime: 'image/jpeg', data: 'ZmFrZQ==' },
    ];

    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

    await uploadFilesServerSide('user123', files);

    expect(mockPutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Metadata: expect.objectContaining({
          uploadedAt: expect.any(String),
          expiresAt: expect.any(String),
        }),
      })
    );

    consoleLogSpy.mockRestore();
  });

  it('should stop and rethrow error on upload failure', async () => {
    const files = [
      { name: 'photo1.jpg', mime: 'image/jpeg', data: 'ZmFrZTE=' },
      { name: 'photo2.jpg', mime: 'image/jpeg', data: 'ZmFrZTI=' },
      { name: 'photo3.jpg', mime: 'image/jpeg', data: 'ZmFrZTM=' },
    ];

    const mockSend = jest.fn()
      .mockResolvedValueOnce({}) // First upload succeeds
      .mockRejectedValueOnce(new Error('Storage quota exceeded')); // Second fails

    mockCreateStorageClient.mockReturnValue({ send: mockSend });

    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

    await expect(uploadFilesServerSide('user123', files)).rejects.toThrow('Storage quota exceeded');

    // Should only upload 2 files (one success, one failure)
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed: photo2.jpg'));

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should log progress for each file', async () => {
    const files = [
      { name: 'file1.jpg', mime: 'image/jpeg', data: 'ZmFrZTE=' },
      { name: 'file2.jpg', mime: 'image/jpeg', data: 'ZmFrZTI=' },
      { name: 'file3.jpg', mime: 'image/jpeg', data: 'ZmFrZTM=' },
    ];

    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

    await uploadFilesServerSide('user123', files);

    const logs = consoleLogSpy.mock.calls.map((call: any) => call.join(' '));
    expect(logs.some((log: string) => log.includes('[1/3]'))).toBe(true);
    expect(logs.some((log: string) => log.includes('[2/3]'))).toBe(true);
    expect(logs.some((log: string) => log.includes('[3/3]'))).toBe(true);
    expect(logs.some((log: string) => log.includes('✓ Success:') && log.includes('staging/user123/file1.jpg'))).toBe(true);
    expect(logs.some((log: string) => log.includes('✓ Success:') && log.includes('staging/user123/file2.jpg'))).toBe(true);
    expect(logs.some((log: string) => log.includes('✓ Success:') && log.includes('staging/user123/file3.jpg'))).toBe(true);

    consoleLogSpy.mockRestore();
  });

  it('should handle empty files array', async () => {
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

    const result = await uploadFilesServerSide('user123', []);

    expect(result).toEqual([]);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Starting upload of'), 0, 'files');

    consoleLogSpy.mockRestore();
  });
});
