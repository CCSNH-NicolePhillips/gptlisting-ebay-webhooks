// scripts/test-local-upload.ts
/**
 * Test local upload function with real images from testDropbox
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { uploadFilesServerSide } from '../src/ingestion/local.js';

async function testLocalUpload() {
  console.log('[test-local-upload] Starting test...\n');
  
  // Get test images from testDropbox/EBAY
  const testDir = join(process.cwd(), 'testDropbox', 'EBAY');
  const files = readdirSync(testDir)
    .filter(f => f.match(/\.(jpg|jpeg|png|gif|webp)$/i))
    .slice(0, 5); // Test with first 5 images
  
  console.log(`[test-local-upload] Found ${files.length} test images:`);
  files.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  console.log();
  
  // Convert to base64 format (same as browser)
  const fileData = files.map(filename => {
    const filePath = join(testDir, filename);
    const buffer = readFileSync(filePath);
    const base64 = buffer.toString('base64');
    
    // Detect mime type
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
    };
    const mime = mimeMap[ext || 'jpg'] || 'image/jpeg';
    
    console.log(`[test-local-upload] Loaded ${filename}: ${buffer.length} bytes → ${base64.length} base64 chars`);
    
    return {
      name: filename,
      mime,
      data: base64,
    };
  });
  
  console.log();
  console.log('[test-local-upload] Calling uploadFilesServerSide...\n');
  
  // Test user ID (same format as JWT sub)
  const testUserId = 'auth0|test-user-123';
  
  try {
    const keys = await uploadFilesServerSide(testUserId, fileData);
    
    console.log('\n[test-local-upload] ✅ Upload successful!');
    console.log(`[test-local-upload] Uploaded ${keys.length} files:\n`);
    keys.forEach((key, i) => {
      console.log(`  ${i + 1}. ${key}`);
    });
    
    console.log('\n[test-local-upload] Test completed successfully! 🎉');
    
  } catch (error: any) {
    console.error('\n[test-local-upload] ❌ Upload failed:');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

// Run test
testLocalUpload().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
