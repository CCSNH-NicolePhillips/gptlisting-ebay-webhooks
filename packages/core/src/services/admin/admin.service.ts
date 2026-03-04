/**
 * packages/core/src/services/admin/admin.service.ts
 *
 * Admin-only operations:
 *  - getEbayRefreshToken  — GET  /api/admin/refresh-token
 *  - listUserImages       — GET  /api/admin/user-images
 *  - setEbayToken         — POST /api/admin/ebay-token
 *  - migrateLegacyTokens  — POST /api/admin/migrate-tokens
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { tokensStore } from '../../../../../src/lib/redis-store.js';
import { userScopedKey } from '../../../../../src/lib/_auth.js';
import { accessTokenFromRefresh, tokenHosts } from '../../../../../src/lib/_common.js';

// ─── Error classes ────────────────────────────────────────────────────────────

export class AdminNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(msg: string) { super(msg); this.name = 'AdminNotFoundError'; }
}

export class AdminTokenError extends Error {
  readonly statusCode = 400;
  constructor(msg: string) { super(msg); this.name = 'AdminTokenError'; }
}

export class AdminStorageError extends Error {
  readonly statusCode = 500;
  constructor(msg: string) { super(msg); this.name = 'AdminStorageError'; }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserImage {
  key: string;
  filename: string;
  size: number | undefined;
  lastModified: string | undefined;
  url: string;
}

export interface MigrateResult {
  migrated: { dropbox: boolean; ebay: boolean };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildS3Client() {
  const bucket = process.env.S3_BUCKET || process.env.R2_BUCKET;
  const region = process.env.STORAGE_REGION || process.env.AWS_REGION || process.env.R2_ACCOUNT_ID || 'us-east-1';
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || '';

  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new AdminStorageError('Storage not configured (missing S3/R2 env vars)');
  }
  const endpoint = process.env.R2_ENDPOINT || undefined;

  return {
    bucket,
    client: new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
      ...(endpoint ? { endpoint } : {}),
    }),
  };
}

// ─── Services ─────────────────────────────────────────────────────────────────

/**
 * Retrieve the eBay refresh token for userId (admin use only).
 * @throws {AdminNotFoundError} if no token is stored
 */
export async function getEbayRefreshToken(userId: string): Promise<{
  refresh_token: string;
  instructions: string;
}> {
  const store = tokensStore();
  const saved = (await store.get(userScopedKey(userId, 'ebay.json'), { type: 'json' })) as any;
  if (!saved?.refresh_token) {
    throw new AdminNotFoundError('No eBay token found. Connect eBay first.');
  }
  return {
    refresh_token: saved.refresh_token,
    instructions: 'Run: node scripts/delete-drafts-simple.mjs YOUR_REFRESH_TOKEN',
  };
}

/**
 * List staged images for a user from S3/R2.
 * @throws {AdminStorageError} if storage is not configured
 */
export async function listUserImages(userId: string): Promise<{
  userId: string;
  bucket: string;
  prefix: string;
  count: number;
  images: UserImage[];
}> {
  const { bucket, client } = buildS3Client();
  const prefix = `staging/${userId}/`;

  const listResult = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000 }));
  const objects = listResult.Contents || [];

  const images = await Promise.all(
    objects.map(async (obj) => {
      const key = obj.Key!;
      const signedUrl = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: 3600 },
      );
      return {
        key,
        filename: key.split('/').pop() || key,
        size: obj.Size,
        lastModified: obj.LastModified?.toISOString(),
        url: signedUrl,
      };
    }),
  );

  images.sort((a, b) => {
    const tA = a.lastModified ? new Date(a.lastModified).getTime() : 0;
    const tB = b.lastModified ? new Date(b.lastModified).getTime() : 0;
    return tB - tA;
  });

  return { userId, bucket, prefix, count: images.length, images };
}

/**
 * Validate and store a new eBay refresh token for userId.
 * Validates the token works before storing it.
 *
 * @throws {AdminTokenError} if the token is invalid or rejected by eBay
 */
export async function setEbayToken(
  userId: string,
  refreshToken: string,
): Promise<{ ok: true; message: string; user: string; env: string }> {
  // Validate: get an access token
  let accessToken: string;
  try {
    const result = await accessTokenFromRefresh(refreshToken);
    accessToken = result.access_token;
  } catch (e: any) {
    throw new AdminTokenError(`Invalid eBay refresh token: ${e.message}`);
  }

  // Validate: probe eBay API
  const ENV = process.env.EBAY_ENV || 'PROD';
  const { apiHost } = tokenHosts(ENV);
  const testRes = await fetch(`${apiHost}/sell/inventory/v1/inventory_item?limit=1`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!testRes.ok) {
    const detail = (await testRes.text()).slice(0, 500);
    throw new AdminTokenError(`Token rejected by eBay API (${testRes.status}): ${detail}`);
  }

  // Store token
  const store = tokensStore();
  await store.setJSON(userScopedKey(userId, 'ebay.json'), { refresh_token: refreshToken });

  return { ok: true, message: 'eBay token stored successfully', user: userId, env: ENV };
}

/**
 * Migrate legacy (global) OAuth tokens into user-scoped Redis keys.
 * Only migrates if the user-scoped key is absent.
 */
export async function migrateLegacyTokens(userId: string): Promise<MigrateResult> {
  const store = tokensStore();
  const userDbxKey = userScopedKey(userId, 'dropbox.json');
  const userEbayKey = userScopedKey(userId, 'ebay.json');

  const [uDbx, uEbay, gDbx, gEbay] = await Promise.all([
    store.get(userDbxKey, { type: 'json' }) as Promise<any>,
    store.get(userEbayKey, { type: 'json' }) as Promise<any>,
    store.get('dropbox.json', { type: 'json' }) as Promise<any>,
    store.get('ebay.json', { type: 'json' }) as Promise<any>,
  ]);

  let migDropbox = false;
  let migEbay = false;

  if (!uDbx?.refresh_token && gDbx?.refresh_token) {
    await store.setJSON(userDbxKey, { refresh_token: gDbx.refresh_token });
    migDropbox = true;
  }
  if (!uEbay?.refresh_token && gEbay?.refresh_token) {
    await store.setJSON(userEbayKey, { refresh_token: gEbay.refresh_token });
    migEbay = true;
  }

  return { migrated: { dropbox: migDropbox, ebay: migEbay } };
}
