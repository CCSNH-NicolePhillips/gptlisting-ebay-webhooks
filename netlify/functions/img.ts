import type { Handler } from '@netlify/functions';
import { generateSignedGetUrl } from '../../src/lib/storage.js';

/**
 * Short URL redirect for S3/R2 images
 * 
 * Purpose: eBay requires picture URLs ≤500 characters, but S3 presigned URLs
 * are ~550+ characters. This function provides a short redirect URL.
 * 
 * Usage:
 *   https://site.com/.netlify/functions/img?k=staging/user/job/hash-file.jpg
 * 
 * The function generates a presigned URL and returns a 302 redirect.
 * eBay will follow the redirect to fetch the actual image.
 * 
 * URL length estimate:
 *   - Base: ~55 chars (https://gptlisting.netlify.app/.netlify/functions/img?k=)
 *   - Key: ~80 chars (staging/google-oauth2_123.../job-uuid/hash-filename.jpg)
 *   - Total: ~135 chars (well under 500 limit)
 */
export const handler: Handler = async (event) => {
  const key = event.queryStringParameters?.k;
  
  if (!key) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing ?k= parameter (S3 object key)' }),
    };
  }
  
  // Basic validation - key should start with staging/ or similar expected prefix
  if (!key.startsWith('staging/')) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid key prefix' }),
    };
  }
  
  try {
    // Generate presigned URL (24 hour expiry by default)
    const signedUrl = await generateSignedGetUrl(key);
    
    // Return redirect to the presigned URL
    // eBay will follow this redirect to fetch the image
    return {
      statusCode: 302,
      headers: {
        'Location': signedUrl,
        'Cache-Control': 'private, max-age=3600', // Cache for 1 hour
      },
      body: '',
    };
  } catch (err: any) {
    console.error('[img] Error generating signed URL:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to generate image URL', detail: err.message }),
    };
  }
};
