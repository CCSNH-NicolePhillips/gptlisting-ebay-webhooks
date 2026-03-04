/**
 * packages/core/src/services/images/local-upload.service.ts
 *
 * Upload in-memory file buffers (from multer) to S3/R2 staging storage.
 * Returns signed URLs (7-day expiry) for each uploaded file.
 *
 * Mirrors: /.netlify/functions/ingest-local-upload
 * Upgrade:  accepts multer buffers instead of base64-in-JSON
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'crypto';

export const MAX_FILES_PER_BATCH = 200;

export type IncomingFile = {
  /** Original file name */
  originalname: string;
  /** MIME type (already validated by upload middleware) */
  mimetype: string;
  /** File content */
  buffer: Buffer;
};

export type UploadedFile = {
  key: string;
  name: string;
  stagedUrl: string;
};

export class LocalUploadError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'LocalUploadError';
    this.statusCode = statusCode;
  }
}

function getStorageClient(): { client: S3Client; bucket: string } {
  const bucket = process.env.S3_BUCKET || process.env.R2_BUCKET || '';
  const region =
    process.env.STORAGE_REGION ||
    process.env.AWS_REGION ||
    process.env.R2_ACCOUNT_ID ||
    'us-east-1';
  const accessKeyId =
    process.env.STORAGE_ACCESS_KEY_ID ||
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.R2_ACCESS_KEY_ID ||
    '';
  const secretAccessKey =
    process.env.STORAGE_SECRET_ACCESS_KEY ||
    process.env.AWS_SECRET_ACCESS_KEY ||
    process.env.R2_SECRET_ACCESS_KEY ||
    '';

  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new LocalUploadError('Storage not configured', 500);
  }

  const client = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });

  return { client, bucket };
}

/**
 * Upload one or more files to S3/R2 staging and return signed URLs.
 *
 * @param userId - Authenticated user id (used to scope the S3 key)
 * @param files  - Multer-style in-memory file objects
 * @returns      - Array of uploaded file metadata with signed URLs
 */
export async function uploadLocalFiles(
  userId: string,
  files: IncomingFile[],
): Promise<{ files: UploadedFile[]; count: number }> {
  if (!files || files.length === 0) {
    throw new LocalUploadError('No files provided', 400);
  }
  if (files.length > MAX_FILES_PER_BATCH) {
    throw new LocalUploadError(
      `Maximum ${MAX_FILES_PER_BATCH} files per batch`,
      429,
    );
  }

  const { client, bucket } = getStorageClient();
  const safeUserId = userId.replace(/[^a-zA-Z0-9\-_.]/g, '_');
  const uploaded: UploadedFile[] = [];

  for (const file of files) {
    const hash = createHash('md5')
      .update(`${userId}-${file.originalname}-${Date.now()}`)
      .digest('hex')
      .substring(0, 16);
    const key = `staging/${safeUserId}/default/${hash}-${file.originalname}`;

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        Metadata: {
          uploadedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 72 * 3600000).toISOString(),
        },
      }),
    );

    const stagedUrl = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: 604800 }, // 7 days
    );

    uploaded.push({ key, name: file.originalname, stagedUrl });
  }

  return { files: uploaded, count: uploaded.length };
}
