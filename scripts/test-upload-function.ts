// scripts/test-upload-function.ts
/**
 * Test the ingest-local-upload function directly without Netlify Dev
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

async function testUploadFunction() {
  console.log('[test] Starting direct function test...\n');
  
  // Get test images
  const testDir = join(process.cwd(), 'testDropbox', 'EBAY');
  const files = readdirSync(testDir)
    .filter(f => f.match(/\.(jpg|jpeg|png)$/i))
    .slice(0, 2); // Just 2 images for quick test
  
  console.log(`[test] Selected ${files.length} test images\n`);
  
  // Convert to base64 (same as browser)
  const fileData = files.map(filename => {
    const filePath = join(testDir, filename);
    const buffer = readFileSync(filePath);
    const base64 = buffer.toString('base64');
    const ext = filename.split('.').pop()?.toLowerCase();
    const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
    
    console.log(`[test] Loaded ${filename}: ${buffer.length} bytes`);
    
    return { name: filename, mime, data: base64 };
  });
  
  console.log('\n[test] Calling function with mock event...\n');
  
  // Mock Netlify event
  const mockEvent = {
    httpMethod: 'POST',
    headers: {
      authorization: 'Bearer fake-test-token',
    },
    body: JSON.stringify({ files: fileData }),
  };
  
  // Import and call the handler
  const { handler } = await import('../netlify/functions/ingest-local-upload.js');
  
  try {
    const result = await handler(mockEvent as any, {} as any);
    
    console.log('\n[test] Function result:');
    console.log('Status:', result.statusCode);
    console.log('Body:', result.body);
    
    if (result.statusCode === 200) {
      console.log('\n✅ SUCCESS! Function works locally!');
    } else {
      console.log('\n❌ Function returned error status');
    }
    
  } catch (error: any) {
    console.error('\n❌ Function threw error:');
    console.error(error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

testUploadFunction();
