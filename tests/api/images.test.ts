/**
 * Express API — images routes
 *
 * Covers:
 *   GET  /api/img              — S3 signed-URL redirect
 *   GET  /api/images/proxy     — External image proxy
 *   POST /api/ingest/local/upload — Multipart image upload
 */

import http from 'http';
import request from 'supertest';
import { jest } from '@jest/globals';

// ── Mocks (must be declared before importing the app) ─────────────────────────

jest.mock('../../src/lib/auth-user.js', () => ({
  requireUserAuth: jest.fn(),
}));

jest.mock('../../packages/core/src/services/images/img.service.js', () => ({
  getSignedImageUrl: jest.fn(),
  InvalidImageKeyError: class InvalidImageKeyError extends Error {
    readonly statusCode = 400;
    constructor(msg: string) {
      super(msg);
      this.name = 'InvalidImageKeyError';
    }
  },
}));

jest.mock('../../packages/core/src/services/images/image-proxy.service.js', () => ({
  proxyImage: jest.fn(),
  ImageProxyError: class ImageProxyError extends Error {
    readonly statusCode: number;
    constructor(msg: string, statusCode = 502) {
      super(msg);
      this.name = 'ImageProxyError';
      this.statusCode = statusCode;
    }
  },
}));

jest.mock('../../packages/core/src/services/images/local-upload.service.js', () => ({
  uploadLocalFiles: jest.fn(),
  LocalUploadError: class LocalUploadError extends Error {
    readonly statusCode: number;
    constructor(msg: string, statusCode = 500) {
      super(msg);
      this.name = 'LocalUploadError';
      this.statusCode = statusCode;
    }
  },
}));

// ── Module references populated in beforeAll ──────────────────────────────────

let server: http.Server;
let mockRequireUserAuth: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetSignedImageUrl: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockProxyImage: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockUploadLocalFiles: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

beforeAll(async () => {
  const { app } = await import('../../apps/api/src/index.js');
  server = app.listen(0);

  const authModule = await import('../../src/lib/auth-user.js');
  mockRequireUserAuth = authModule.requireUserAuth as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const imgModule = await import('../../packages/core/src/services/images/img.service.js');
  mockGetSignedImageUrl = imgModule.getSignedImageUrl as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const proxyModule = await import('../../packages/core/src/services/images/image-proxy.service.js');
  mockProxyImage = proxyModule.proxyImage as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const uploadModule = await import('../../packages/core/src/services/images/local-upload.service.js');
  mockUploadLocalFiles = uploadModule.uploadLocalFiles as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;
});

afterAll((done) => { server.close(done); });

beforeEach(() => {
  jest.resetAllMocks();
  process.env.NODE_ENV = 'test';
});

const MOCK_USER = { sub: 'user|abc', email: 'test@example.com', userId: 'user|abc' };

// ─── GET /api/img ─────────────────────────────────────────────────────────────

describe('GET /api/img', () => {
  it('redirects 302 to signed URL for valid staging key', async () => {
    mockGetSignedImageUrl.mockResolvedValue('https://s3.example.com/signed-url?X-Amz-Signature=abc');
    const res = await request(server).get('/api/img?k=staging/user/job/hash-photo.jpg');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('s3.example.com');
  });

  it('returns 400 when ?k is missing', async () => {
    const { InvalidImageKeyError } = await import('../../packages/core/src/services/images/img.service.js');
    mockGetSignedImageUrl.mockRejectedValue(
      new (InvalidImageKeyError as any)('Missing ?k= parameter (S3 object key)'),
    );
    const res = await request(server).get('/api/img');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns 400 when key has invalid prefix', async () => {
    const { InvalidImageKeyError } = await import('../../packages/core/src/services/images/img.service.js');
    mockGetSignedImageUrl.mockRejectedValue(
      new (InvalidImageKeyError as any)('Invalid key prefix'),
    );
    const res = await request(server).get('/api/img?k=uploads/evil.jpg');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/key prefix/i);
  });

  it('returns 500 on unexpected storage error', async () => {
    mockGetSignedImageUrl.mockRejectedValue(new Error('S3 unavailable'));
    const res = await request(server).get('/api/img?k=staging/user/job/file.jpg');
    expect(res.status).toBe(500);
  });
});

// ─── GET /api/images/proxy ────────────────────────────────────────────────────

describe('GET /api/images/proxy', () => {
  const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // JPEG magic bytes

  it('returns 200 JPEG buffer for valid image URL', async () => {
    mockProxyImage.mockResolvedValue({ buffer: FAKE_JPEG, contentType: 'image/jpeg' });
    const res = await request(server)
      .get('/api/images/proxy?url=https://example.com/photo.jpg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(mockProxyImage).toHaveBeenCalledWith('https://example.com/photo.jpg');
  });

  it('returns 400 when ?url is missing', async () => {
    const { ImageProxyError } = await import('../../packages/core/src/services/images/image-proxy.service.js');
    mockProxyImage.mockRejectedValue(
      new (ImageProxyError as any)('Missing ?url parameter', 400),
    );
    const res = await request(server).get('/api/images/proxy');
    expect(res.status).toBe(400);
  });

  it('returns 400 for non-https URL', async () => {
    const { ImageProxyError } = await import('../../packages/core/src/services/images/image-proxy.service.js');
    mockProxyImage.mockRejectedValue(
      new (ImageProxyError as any)('Only https URLs are allowed', 400),
    );
    const res = await request(server)
      .get('/api/images/proxy?url=http://insecure.example.com/img.jpg');
    expect(res.status).toBe(400);
  });

  it('returns 415 when proxied content is not an image', async () => {
    const { ImageProxyError } = await import('../../packages/core/src/services/images/image-proxy.service.js');
    mockProxyImage.mockRejectedValue(
      new (ImageProxyError as any)('Not an image (type=text/html)', 415),
    );
    const res = await request(server)
      .get('/api/images/proxy?url=https://example.com/page.html');
    expect(res.status).toBe(415);
  });

  it('returns 413 when compressed image is still too large', async () => {
    const { ImageProxyError } = await import('../../packages/core/src/services/images/image-proxy.service.js');
    mockProxyImage.mockRejectedValue(
      new (ImageProxyError as any)('Image too large after compression', 413),
    );
    const res = await request(server)
      .get('/api/images/proxy?url=https://example.com/huge.jpg');
    expect(res.status).toBe(413);
  });

  it('returns 502 on upstream fetch failure', async () => {
    const { ImageProxyError } = await import('../../packages/core/src/services/images/image-proxy.service.js');
    mockProxyImage.mockRejectedValue(
      new (ImageProxyError as any)('Upstream fetch failed: 404', 404),
    );
    const res = await request(server)
      .get('/api/images/proxy?url=https://example.com/gone.jpg');
    expect(res.status).toBe(404);
  });
});

// ─── POST /api/ingest/local/upload ───────────────────────────────────────────

describe('POST /api/ingest/local/upload', () => {
  // Small valid PNG buffer (1x1 pixel)
  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );

  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server)
      .post('/api/ingest/local/upload')
      .attach('files', TINY_PNG, { filename: 'test.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when no files are attached', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .post('/api/ingest/local/upload')
      .set('Authorization', 'Bearer tok')
      // No .attach() → multipart body is empty, req.files will be empty/undefined
      .field('dummy', 'value');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no files/i);
  });

  it('returns 200 with file metadata on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const uploadResult = {
      files: [{ key: 'staging/user_abc/default/abc123-test.png', name: 'test.png', stagedUrl: 'https://s3.example.com/signed' }],
      count: 1,
    };
    mockUploadLocalFiles.mockResolvedValue(uploadResult);

    const res = await request(server)
      .post('/api/ingest/local/upload')
      .set('Authorization', 'Bearer tok')
      .attach('files', TINY_PNG, { filename: 'test.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].stagedUrl).toBe('https://s3.example.com/signed');
    expect(mockUploadLocalFiles).toHaveBeenCalledWith(
      MOCK_USER.userId,
      expect.arrayContaining([
        expect.objectContaining({ originalname: 'test.png', mimetype: 'image/png' }),
      ]),
    );
  });

  it('returns 413 when file exceeds size limit', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    // 11 MiB > default 10 MiB limit
    const bigBuffer = Buffer.alloc(11 * 1024 * 1024);

    const res = await request(server)
      .post('/api/ingest/local/upload')
      .set('Authorization', 'Bearer tok')
      .attach('files', bigBuffer, { filename: 'huge.png', contentType: 'image/png' });

    expect(res.status).toBe(413);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/too large/i);
  });

  it('returns 415 when file has unsupported MIME type', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .post('/api/ingest/local/upload')
      .set('Authorization', 'Bearer tok')
      .attach('files', Buffer.from('<svg/>'), { filename: 'hack.svg', contentType: 'image/svg+xml' });

    expect(res.status).toBe(415);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/unsupported media type/i);
  });

  it('returns 500 on storage failure', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { LocalUploadError } = await import('../../packages/core/src/services/images/local-upload.service.js');
    mockUploadLocalFiles.mockRejectedValue(
      new (LocalUploadError as any)('Storage not configured', 500),
    );

    const res = await request(server)
      .post('/api/ingest/local/upload')
      .set('Authorization', 'Bearer tok')
      .attach('files', TINY_PNG, { filename: 'test.png', contentType: 'image/png' });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });

  it('returns 429 when too many files sent', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { LocalUploadError } = await import('../../packages/core/src/services/images/local-upload.service.js');
    mockUploadLocalFiles.mockRejectedValue(
      new (LocalUploadError as any)('Maximum 200 files per batch', 429),
    );

    const res = await request(server)
      .post('/api/ingest/local/upload')
      .set('Authorization', 'Bearer tok')
      .attach('files', TINY_PNG, { filename: 'test.png', contentType: 'image/png' });

    expect(res.status).toBe(429);
  });
});
