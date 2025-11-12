// src/lib/mime.ts
/**
 * MIME type utilities for file validation and guessing
 */

/** Supported image MIME types */
export const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

export type SupportedImageType = typeof SUPPORTED_IMAGE_TYPES[number];

/**
 * Guess MIME type from file extension
 */
export function guessMime(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    tif: 'image/tiff',
  };
  
  return mimeMap[ext || ''] || 'application/octet-stream';
}

/**
 * Validate that MIME type is a supported image
 */
export function isValidImageMime(mime: string): boolean {
  return SUPPORTED_IMAGE_TYPES.includes(mime as SupportedImageType);
}

/**
 * Get file extension from MIME type
 */
export function getExtensionFromMime(mime: string): string {
  const extMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
  };
  
  return extMap[mime.toLowerCase()] || 'jpg';
}

/**
 * Check if filename has an image extension
 */
export function hasImageExtension(filename: string): boolean {
  const ext = filename.toLowerCase().split('.').pop();
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'tif'].includes(ext || '');
}

/**
 * Sanitize filename for storage (remove special characters, limit length)
 */
export function sanitizeFilename(filename: string): string {
  // Replace spaces and special chars with underscores
  const sanitized = filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/__+/g, '_')
    .replace(/^_+|_+$/g, '');
  
  // Limit to 100 chars before extension
  const parts = sanitized.split('.');
  const ext = parts.length > 1 ? parts.pop() : '';
  const name = parts.join('.');
  
  const truncated = name.slice(0, 100);
  return ext ? `${truncated}.${ext}` : truncated;
}
