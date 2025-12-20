/**
 * Admin endpoint to list all staged images for a user
 * GET /.netlify/functions/admin-list-user-images?userId=xxx
 */

import { Handler } from "@netlify/functions";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const jsonResponse = (statusCode: number, body: any) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const handler: Handler = async (event) => {
  try {
    const userId = event.queryStringParameters?.userId;
    
    if (!userId) {
      return jsonResponse(400, { error: 'userId parameter required' });
    }
    
    console.log('[admin-list-user-images] Listing images for user:', userId);
    
    // Get S3/R2 config
    const bucket = process.env.S3_BUCKET || process.env.R2_BUCKET;
    const region = process.env.STORAGE_REGION || process.env.AWS_REGION || process.env.R2_ACCOUNT_ID || 'us-east-1';
    const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '';
    const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || '';
    
    if (!bucket || !accessKeyId || !secretAccessKey) {
      return jsonResponse(500, { 
        error: 'Storage not configured',
        message: 'S3/R2 environment variables missing'
      });
    }
    
    const client = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey }
    });
    
    // List all objects in user's staging folder
    const prefix = `staging/${userId}/`;
    console.log('[admin-list-user-images] Listing objects with prefix:', prefix);
    
    const listCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: 1000, // Max images to list
    });
    
    const listResult = await client.send(listCommand);
    const objects = listResult.Contents || [];
    
    console.log('[admin-list-user-images] Found', objects.length, 'objects');
    
    // Generate signed URLs for each image
    const images = await Promise.all(
      objects.map(async (obj) => {
        const key = obj.Key!;
        const filename = key.split('/').pop() || key;
        
        // Generate signed URL (valid for 1 hour)
        const signedUrl = await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          { expiresIn: 3600 }
        );
        
        return {
          key,
          filename,
          size: obj.Size,
          lastModified: obj.LastModified?.toISOString(),
          url: signedUrl,
        };
      })
    );
    
    // Sort by most recent first
    images.sort((a, b) => {
      const dateA = a.lastModified ? new Date(a.lastModified).getTime() : 0;
      const dateB = b.lastModified ? new Date(b.lastModified).getTime() : 0;
      return dateB - dateA;
    });
    
    console.log('[admin-list-user-images] Generated', images.length, 'signed URLs');
    
    return jsonResponse(200, {
      ok: true,
      userId,
      bucket,
      prefix,
      count: images.length,
      images,
    });
    
  } catch (error: any) {
    console.error('[admin-list-user-images] Error:', error);
    return jsonResponse(500, {
      error: 'Failed to list images',
      message: error.message,
    });
  }
};
