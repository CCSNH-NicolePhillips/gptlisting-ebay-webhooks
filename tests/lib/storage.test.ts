// Set up environment before any imports
process.env.R2_BUCKET = 'test-bucket';
process.env.R2_ACCESS_KEY_ID = 'test-access-key';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.R2_ACCOUNT_ID = 'test-account-id';
process.env.STAGING_RETENTION_HOURS = '48';

// Mock AWS SDK v3
const mockSend = jest.fn();
const mockGetSignedUrl = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: mockSend
  })),
  PutObjectCommand: jest.fn((input) => ({ input, commandName: 'PutObjectCommand' })),
  GetObjectCommand: jest.fn((input) => ({ input, commandName: 'GetObjectCommand' })),
  CopyObjectCommand: jest.fn((input) => ({ input, commandName: 'CopyObjectCommand' }))
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl
}));

// Mock node-fetch
const mockFetch = jest.fn();
jest.mock('node-fetch', () => ({
  __esModule: true,
  default: mockFetch
}));

import {
  getStagingConfig,
  createStorageClient,
  generateStagingKey,
  generatePresignedPutUrl,
  generateSignedGetUrl,
  getStagedUrl,
  copyToStaging,
  generatePresignedUploads,
  getUserStagingUsage,
  deleteStagedFiles
} from '../../src/lib/storage';

describe('storage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset to default test environment
    process.env.R2_BUCKET = 'test-bucket';
    process.env.R2_ACCESS_KEY_ID = 'test-access-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret-key';
    process.env.R2_ACCOUNT_ID = 'test-account-id';
    process.env.STAGING_RETENTION_HOURS = '48';
    delete process.env.S3_BUCKET;
    delete process.env.STORAGE_ACCESS_KEY_ID;
    delete process.env.STORAGE_SECRET_ACCESS_KEY;
    delete process.env.STORAGE_REGION;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_REGION;
    delete process.env.R2_PUBLIC_URL;
  });

  describe('getStagingConfig', () => {
    it('should return R2 config when R2 env vars are set', () => {
      const config = getStagingConfig();

      expect(config).toEqual({
        bucket: 'test-bucket',
        accountId: 'test-account-id',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
        publicUrlBase: undefined,
        retentionHours: 48
      });
    });

    it('should prioritize R2 vars over AWS vars', () => {
      process.env.S3_BUCKET = 'aws-bucket';
      process.env.AWS_ACCESS_KEY_ID = 'aws-access';
      process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';

      const config = getStagingConfig();

      expect(config.bucket).toBe('test-bucket');
      expect(config.accessKeyId).toBe('test-access-key');
    });

    it('should fall back to AWS vars when R2 vars not set', () => {
      delete process.env.R2_BUCKET;
      delete process.env.R2_ACCESS_KEY_ID;
      delete process.env.R2_SECRET_ACCESS_KEY;
      delete process.env.R2_ACCOUNT_ID;

      process.env.S3_BUCKET = 'aws-bucket';
      process.env.AWS_ACCESS_KEY_ID = 'aws-access';
      process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
      process.env.AWS_REGION = 'us-east-1';

      const config = getStagingConfig();

      expect(config.bucket).toBe('aws-bucket');
      expect(config.accountId).toBe('us-east-1');
      expect(config.accessKeyId).toBe('aws-access');
      expect(config.secretAccessKey).toBe('aws-secret');
    });

    it('should throw error when bucket is not configured', () => {
      delete process.env.R2_BUCKET;
      delete process.env.S3_BUCKET;

      expect(() => getStagingConfig()).toThrow('R2_BUCKET or S3_BUCKET environment variable required');
    });

    it('should throw error when access key is not configured', () => {
      delete process.env.R2_ACCESS_KEY_ID;
      delete process.env.STORAGE_ACCESS_KEY_ID;
      delete process.env.AWS_ACCESS_KEY_ID;

      expect(() => getStagingConfig()).toThrow('Storage credentials required');
    });

    it('should throw error when secret key is not configured', () => {
      delete process.env.R2_SECRET_ACCESS_KEY;
      delete process.env.STORAGE_SECRET_ACCESS_KEY;
      delete process.env.AWS_SECRET_ACCESS_KEY;

      expect(() => getStagingConfig()).toThrow('Storage credentials required');
    });

    it('should use default retention hours when not specified', () => {
      delete process.env.STAGING_RETENTION_HOURS;

      const config = getStagingConfig();

      expect(config.retentionHours).toBe(72);
    });

    it('should include public URL base when configured', () => {
      process.env.R2_PUBLIC_URL = 'https://cdn.example.com';

      const config = getStagingConfig();

      expect(config.publicUrlBase).toBe('https://cdn.example.com');
    });
  });

  describe('createStorageClient', () => {
    it('should create R2 client with path-style URLs', () => {
      const { S3Client } = require('@aws-sdk/client-s3');

      createStorageClient();

      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'auto',
          endpoint: 'https://test-account-id.r2.cloudflarestorage.com',
          forcePathStyle: true,
          credentials: {
            accessKeyId: 'test-access-key',
            secretAccessKey: 'test-secret-key'
          }
        })
      );
    });

    it('should create AWS S3 client without endpoint when accountId looks like region', () => {
      // Create a custom config to bypass module-level env vars
      const awsConfig = {
        bucket: 'aws-bucket',
        accountId: 'us-east-1',
        accessKeyId: 'aws-access',
        secretAccessKey: 'aws-secret',
        retentionHours: 72
      };

      const { S3Client } = require('@aws-sdk/client-s3');
      S3Client.mockClear();

      createStorageClient(awsConfig);

      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'us-east-1',
          credentials: {
            accessKeyId: 'aws-access',
            secretAccessKey: 'aws-secret'
          }
        })
      );
      expect(S3Client.mock.calls[0][0].endpoint).toBeUndefined();
    });

    it('should accept custom config parameter', () => {
      const customConfig = {
        bucket: 'custom-bucket',
        accountId: 'custom-account',
        accessKeyId: 'custom-key',
        secretAccessKey: 'custom-secret',
        retentionHours: 24
      };

      const { S3Client } = require('@aws-sdk/client-s3');
      S3Client.mockClear();

      createStorageClient(customConfig);

      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: {
            accessKeyId: 'custom-key',
            secretAccessKey: 'custom-secret'
          }
        })
      );
    });

    it('should default to us-east-1 region when no accountId', () => {
      delete process.env.R2_ACCOUNT_ID;
      delete process.env.AWS_REGION;
      process.env.R2_BUCKET = 'test-bucket';

      const { S3Client } = require('@aws-sdk/client-s3');
      S3Client.mockClear();

      createStorageClient();

      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'us-east-1'
        })
      );
    });
  });

  describe('generateStagingKey', () => {
    let originalDateNow: () => number;
    const mockTimestamp = 1234567890000;

    beforeEach(() => {
      originalDateNow = Date.now;
      Date.now = jest.fn(() => mockTimestamp);
    });

    afterEach(() => {
      Date.now = originalDateNow;
    });

    it('should generate key with userId, jobId, and sanitized filename', () => {
      const key = generateStagingKey('user123', 'test-file.jpg', 'job456');

      expect(key).toContain('staging/user123/job456/');
      expect(key).toContain('test-file.jpg');
    });

    it('should use "default" when jobId is not provided', () => {
      const key = generateStagingKey('user123', 'test.jpg');

      expect(key).toContain('staging/user123/default/');
    });

    it('should include hash in the key', () => {
      const key = generateStagingKey('user123', 'test.jpg', 'job456');

      // Key format: staging/{userId}/{jobId}/{hash}-{filename}
      const parts = key.split('/');
      expect(parts).toHaveLength(4);
      expect(parts[3]).toMatch(/^[a-f0-9]{16}-/); // 16 char hex hash prefix
    });

    it('should sanitize filename', () => {
      const key = generateStagingKey('user123', '../../../etc/passwd', 'job456');

      expect(key).not.toContain('..');
      expect(key).not.toContain('etc/passwd');
    });

    it('should generate different keys for same filename at different times', () => {
      const key1 = generateStagingKey('user123', 'test.jpg', 'job456');
      
      Date.now = jest.fn(() => mockTimestamp + 1000);
      
      const key2 = generateStagingKey('user123', 'test.jpg', 'job456');

      expect(key1).not.toBe(key2);
    });

    it('should handle special characters in filename', () => {
      const key = generateStagingKey('user123', 'file with spaces & special!.jpg', 'job456');

      expect(key).toContain('staging/user123/job456/');
      expect(key).toMatch(/\.jpg$/);
    });

    // UserId sanitization tests - fixes for S3 presigned URL signature issues
    describe('userId sanitization', () => {
      it('should sanitize pipe character in OAuth userIds', () => {
        const userId = 'google-oauth2|108767599998494531403';
        const key = generateStagingKey(userId, 'test-image.jpg', 'job123');

        // Should NOT contain pipe character (breaks presigned URL signatures)
        expect(key).not.toContain('|');
        expect(key).not.toContain('%7C');
        
        // Should contain underscore-replaced userId
        expect(key).toContain('google-oauth2_108767599998494531403');
      });

      it('should sanitize Auth0 format userIds', () => {
        const userId = 'auth0|abc123def456';
        const key = generateStagingKey(userId, 'product.jpg', 'job123');

        expect(key).toContain('auth0_abc123def456');
        expect(key).not.toContain('|');
      });

      it('should sanitize email-based userIds', () => {
        const userId = 'email|user@example.com';
        const key = generateStagingKey(userId, 'photo.png', 'job123');

        // @ and | should be replaced
        expect(key).not.toContain('@');
        expect(key).not.toContain('|');
      });

      it('should sanitize multiple special characters', () => {
        const userId = 'auth0|user@email.com:special!char';
        const key = generateStagingKey(userId, 'photo.png', 'job123');

        // Extract the userId segment from the key
        const userIdPart = key.split('/')[1]; // staging/{userId}/...
        
        // Should only contain safe characters: a-zA-Z0-9-_.
        expect(userIdPart).toMatch(/^[a-zA-Z0-9\-_.]+$/);
        
        // Should not contain any of: | @ : !
        expect(key).not.toContain('|');
        expect(key).not.toContain('@');
        expect(key).not.toContain(':');
        expect(key).not.toContain('!');
      });

      it('should preserve already-safe userIds unchanged', () => {
        const userId = 'simple-user-123';
        const key = generateStagingKey(userId, 'image.jpg', 'job456');

        // Should contain the original userId unchanged
        expect(key).toContain('staging/simple-user-123/job456/');
      });

      it('should handle real-world Dropbox upload userId', () => {
        // This is the exact format that was causing issues
        const userId = 'google-oauth2|108767599998494531403';
        const filename = 'IMG_20251225_160607.jpg';
        const jobId = '11b7ae84-d4e3-4a96-8d6d-45c2d5e5d2ab';

        const key = generateStagingKey(userId, filename, jobId);

        // Key should be S3-safe (no characters that break presigned URLs)
        expect(key).not.toContain('|');
        
        // Should still identify the user uniquely
        expect(key).toContain('google-oauth2_108767599998494531403');
        
        // Should contain the job ID
        expect(key).toContain('11b7ae84-d4e3-4a96-8d6d-45c2d5e5d2ab');
      });

      it('should handle empty userId gracefully', () => {
        const userId = '';
        const filename = 'test.jpg';

        // Should not throw
        expect(() => generateStagingKey(userId, filename)).not.toThrow();
      });

      it('should handle anonymous fallback', () => {
        const userId = 'anonymous';
        const filename = 'dropbox-image.jpg';
        const jobId = 'dropbox-job-789';

        const key = generateStagingKey(userId, filename, jobId);

        expect(key).toContain('staging/anonymous/dropbox-job-789/');
      });
    });
  });

  describe('generatePresignedPutUrl', () => {
    it('should generate presigned PUT URL with default expiration', async () => {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      mockGetSignedUrl.mockResolvedValueOnce('https://presigned-put-url.com');

      const url = await generatePresignedPutUrl('staging/user123/job456/test.jpg', 'image/jpeg');

      expect(url).toBe('https://presigned-put-url.com');
      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Bucket: 'test-bucket',
          Key: 'staging/user123/job456/test.jpg',
          ContentType: 'image/jpeg',
          Metadata: expect.objectContaining({
            uploadedAt: expect.any(String),
            expiresAt: expect.any(String)
          })
        })
      );
      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 600 }
      );
    });

    it('should use custom expiration time', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://presigned-url.com');

      await generatePresignedPutUrl('test-key', 'image/png', 300);

      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 300 }
      );
    });

    it('should set metadata with retention hours', async () => {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      mockGetSignedUrl.mockResolvedValueOnce('https://url.com');

      await generatePresignedPutUrl('test-key', 'application/pdf');

      const call = PutObjectCommand.mock.calls[0][0];
      expect(call.Metadata).toBeDefined();
      expect(call.Metadata.uploadedAt).toBeDefined();
      expect(call.Metadata.expiresAt).toBeDefined();
      
      const uploaded = new Date(call.Metadata.uploadedAt).getTime();
      const expires = new Date(call.Metadata.expiresAt).getTime();
      const diffHours = (expires - uploaded) / (1000 * 60 * 60);
      
      expect(diffHours).toBeCloseTo(48, 5); // STAGING_RETENTION_HOURS with float precision
    });
  });

  describe('generateSignedGetUrl', () => {
    it('should generate signed GET URL with default expiration', async () => {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      mockGetSignedUrl.mockResolvedValueOnce('https://signed-get-url.com');

      const url = await generateSignedGetUrl('staging/user123/test.jpg');

      expect(url).toBe('https://signed-get-url.com');
      expect(GetObjectCommand).toHaveBeenCalledWith({
        Bucket: 'test-bucket',
        Key: 'staging/user123/test.jpg'
      });
      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 86400 }
      );
    });

    it('should use custom expiration time', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://url.com');

      await generateSignedGetUrl('test-key', 3600);

      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 3600 }
      );
    });
  });

  describe('getStagedUrl', () => {
    it('should return public URL when R2_PUBLIC_URL is configured', async () => {
      process.env.R2_PUBLIC_URL = 'https://cdn.example.com';

      const url = await getStagedUrl('staging/user123/test.jpg');

      expect(url).toBe('https://cdn.example.com/staging/user123/test.jpg');
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });

    it('should generate signed URL when R2_PUBLIC_URL is not configured', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://signed-url.com');

      const url = await getStagedUrl('staging/user123/test.jpg');

      expect(url).toBe('https://signed-url.com');
      expect(mockGetSignedUrl).toHaveBeenCalled();
    });

    it('should handle keys with special characters', async () => {
      process.env.R2_PUBLIC_URL = 'https://cdn.example.com';

      const url = await getStagedUrl('staging/user123/file with spaces.jpg');

      expect(url).toBe('https://cdn.example.com/staging/user123/file with spaces.jpg');
    });
  });

  describe('copyToStaging', () => {
    let originalDateNow: () => number;

    beforeEach(() => {
      originalDateNow = Date.now;
      Date.now = jest.fn(() => 1234567890000);
    });

    afterEach(() => {
      Date.now = originalDateNow;
    });

    it('should fetch from source and upload to staging', async () => {
      const mockArrayBuffer = new ArrayBuffer(100);
      const mockFetchImpl = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => mockArrayBuffer
      });
      // Temporarily replace global fetch for this test
      global.fetch = mockFetchImpl as any;
      mockSend.mockResolvedValueOnce({});

      const key = await copyToStaging(
        'https://example.com/image.jpg',
        'user123',
        'image.jpg',
        'image/jpeg',
        'job456'
      );

      expect(key).toContain('staging/user123/job456/');
      expect(mockFetchImpl).toHaveBeenCalledWith('https://example.com/image.jpg');
      expect(mockSend).toHaveBeenCalled();
    });

    it('should include metadata in upload', async () => {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const mockFetchImpl = jest.fn().mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100)
      });
      global.fetch = mockFetchImpl as any;
      mockSend.mockResolvedValueOnce({});

      await copyToStaging(
        'https://source.com/file.png',
        'user123',
        'file.png',
        'image/png'
      );

      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          ContentType: 'image/png',
          Metadata: expect.objectContaining({
            uploadedAt: expect.any(String),
            expiresAt: expect.any(String),
            sourceUrl: 'https://source.com/file.png'
          })
        })
      );
    });

    it('should throw error when fetch fails', async () => {
      const mockFetchImpl = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 404
      });
      global.fetch = mockFetchImpl as any;

      await expect(
        copyToStaging('https://example.com/missing.jpg', 'user123', 'file.jpg', 'image/jpeg')
      ).rejects.toThrow('Failed to copy to staging');
    });

    it('should throw error when upload fails', async () => {
      const mockFetchImpl = jest.fn().mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100)
      });
      global.fetch = mockFetchImpl as any;
      mockSend.mockRejectedValueOnce(new Error('S3 error'));

      await expect(
        copyToStaging('https://example.com/image.jpg', 'user123', 'file.jpg', 'image/jpeg')
      ).rejects.toThrow('Failed to copy to staging: S3 error');
    });

    it('should handle network errors', async () => {
      const mockFetchImpl = jest.fn().mockRejectedValueOnce(new Error('Network error'));
      global.fetch = mockFetchImpl as any;

      await expect(
        copyToStaging('https://example.com/image.jpg', 'user123', 'file.jpg', 'image/jpeg')
      ).rejects.toThrow('Failed to copy to staging');
    });

    it('should convert ArrayBuffer to Uint8Array', async () => {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const mockArrayBuffer = new ArrayBuffer(100);
      const mockFetchImpl = jest.fn().mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => mockArrayBuffer
      });
      global.fetch = mockFetchImpl as any;
      mockSend.mockResolvedValueOnce({});

      await copyToStaging('https://example.com/image.jpg', 'user123', 'file.jpg', 'image/jpeg');

      const commandCall = PutObjectCommand.mock.calls[PutObjectCommand.mock.calls.length - 1][0];
      expect(commandCall.Body).toBeInstanceOf(Uint8Array);
      expect(commandCall.Body.byteLength).toBe(100);
    });
  });

  describe('generatePresignedUploads', () => {
    it('should generate multiple presigned URLs', async () => {
      mockGetSignedUrl
        .mockResolvedValueOnce('https://url1.com')
        .mockResolvedValueOnce('https://url2.com')
        .mockResolvedValueOnce('https://url3.com');

      const fileInfos = [
        { name: 'file1.jpg', mime: 'image/jpeg' },
        { name: 'file2.png', mime: 'image/png' },
        { name: 'file3.pdf', mime: 'application/pdf' }
      ];

      const uploads = await generatePresignedUploads('user123', fileInfos, 'job456');

      expect(uploads).toHaveLength(3);
      expect(uploads[0]).toEqual({
        url: 'https://url1.com',
        key: expect.stringContaining('file1.jpg'),
        mime: 'image/jpeg'
      });
      expect(uploads[1]).toEqual({
        url: 'https://url2.com',
        key: expect.stringContaining('file2.png'),
        mime: 'image/png'
      });
      expect(uploads[2]).toEqual({
        url: 'https://url3.com',
        key: expect.stringContaining('file3.pdf'),
        mime: 'application/pdf'
      });
    });

    it('should generate keys with jobId', async () => {
      mockGetSignedUrl.mockResolvedValue('https://url.com');

      const uploads = await generatePresignedUploads(
        'user123',
        [{ name: 'test.jpg', mime: 'image/jpeg' }],
        'job456'
      );

      expect(uploads[0].key).toContain('staging/user123/job456/');
    });

    it('should use default jobId when not provided', async () => {
      mockGetSignedUrl.mockResolvedValue('https://url.com');

      const uploads = await generatePresignedUploads(
        'user123',
        [{ name: 'test.jpg', mime: 'image/jpeg' }]
      );

      expect(uploads[0].key).toContain('staging/user123/default/');
    });

    it('should handle empty array', async () => {
      const uploads = await generatePresignedUploads('user123', []);

      expect(uploads).toEqual([]);
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });

    it('should handle errors in URL generation', async () => {
      mockGetSignedUrl.mockRejectedValueOnce(new Error('Signing failed'));

      await expect(
        generatePresignedUploads('user123', [{ name: 'test.jpg', mime: 'image/jpeg' }])
      ).rejects.toThrow('Signing failed');
    });
  });

  describe('getUserStagingUsage', () => {
    it('should return 0 (not implemented)', async () => {
      const usage = await getUserStagingUsage('user123');

      expect(usage).toBe(0);
    });
  });

  describe('deleteStagedFiles', () => {
    it('should complete without error (relies on lifecycle rules)', async () => {
      await expect(
        deleteStagedFiles(['key1', 'key2', 'key3'])
      ).resolves.toBeUndefined();
    });

    it('should handle empty array', async () => {
      await expect(
        deleteStagedFiles([])
      ).resolves.toBeUndefined();
    });
  });

  describe('Edge cases', () => {
    it('should handle very long filenames', () => {
      const longName = 'a'.repeat(500) + '.jpg';
      const key = generateStagingKey('user123', longName, 'job456');

      expect(key).toBeDefined();
      expect(key).toContain('staging/user123/job456/');
    });

    it('should handle unicode characters in filename', () => {
      const key = generateStagingKey('user123', '测试文件.jpg', 'job456');

      expect(key).toBeDefined();
      expect(key).toContain('staging/user123/job456/');
    });

    it('should handle empty filename', () => {
      const key = generateStagingKey('user123', '', 'job456');

      expect(key).toBeDefined();
      expect(key).toContain('staging/user123/job456/');
    });

    it('should handle special mime types', async () => {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      mockGetSignedUrl.mockResolvedValueOnce('https://url.com');

      await generatePresignedPutUrl('test-key', 'application/vnd.ms-excel');

      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          ContentType: 'application/vnd.ms-excel'
        })
      );
    });
  });
});
