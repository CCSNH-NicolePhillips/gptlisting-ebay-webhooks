/**
 * packages/core/src/services/images/img.service.ts
 *
 * Short image URL service.
 *
 * eBay requires picture URLs ≤500 characters, but S3/R2 presigned URLs are
 * often 550+ characters. This service generates a signed GET URL for a given
 * S3 object key so the Express endpoint can issue a 302 redirect.
 *
 * Mirrors: /.netlify/functions/img
 */

import { generateSignedGetUrl } from '../../../../../src/lib/storage.js';

export class InvalidImageKeyError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidImageKeyError';
  }
}

/**
 * Validate an S3 staging key and return a presigned signed URL.
 *
 * @param key  - S3 object key, e.g. "staging/user_123/job-abc/hash-file.jpg"
 * @returns    - Signed URL (24 h expiry)
 * @throws     - InvalidImageKeyError for missing / invalid keys
 */
export async function getSignedImageUrl(key: string): Promise<string> {
  if (!key) {
    throw new InvalidImageKeyError('Missing ?k= parameter (S3 object key)');
  }
  if (!key.startsWith('staging/')) {
    throw new InvalidImageKeyError('Invalid key prefix');
  }

  return generateSignedGetUrl(key);
}
