// Test CLIP endpoint directly to verify embeddings differ
import { readFileSync } from 'fs';
import { config } from 'dotenv';

config({ path: './prod.env' });

const HF_TOKEN = process.env.HF_API_TOKEN;
const IMAGE_BASE = process.env.HF_IMAGE_ENDPOINT_BASE;

async function testImage(imagePath) {
  const bytes = readFileSync(imagePath);
  const b64 = bytes.toString('base64');
  
  console.log(`\nTesting: ${imagePath}`);
  console.log(`Size: ${bytes.length} bytes`);
  
  const response = await fetch(IMAGE_BASE, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HF_TOKEN}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inputs: `data:image/jpeg;base64,${b64}` })
  });
  
  if (!response.ok) {
    console.error(`Error: ${response.status} ${response.statusText}`);
    const text = await response.text();
    console.error(text);
    return null;
  }
  
  const json = await response.json();
  console.log('Response type:', typeof json);
  console.log('Is array:', Array.isArray(json));
  
  let embedding = null;
  if (Array.isArray(json) && typeof json[0] === 'number') {
    embedding = json;
  } else if (Array.isArray(json) && Array.isArray(json[0])) {
    embedding = json[0];
  } else if (json.embeddings) {
    embedding = json.embeddings;
  } else if (json.embedding) {
    embedding = json.embedding;
  }
  
  if (embedding) {
    console.log('Embedding length:', embedding.length);
    console.log('First 10 values:', embedding.slice(0, 10));
    
    // Compute a hash
    let hash = 0;
    for (let i = 0; i < Math.min(10, embedding.length); i++) {
      hash += (i + 1) * embedding[i];
    }
    console.log('Hash (first 10):', hash.toFixed(6));
    
    return embedding;
  } else {
    console.log('Could not extract embedding from response:', json);
    return null;
  }
}

// Test with two different images (you'll need to provide paths)
console.log('='.repeat(60));
console.log('CLIP Endpoint Test');
console.log('='.repeat(60));

// Replace these with actual image paths from your test set
const testImages = [
    'C:\\Users\\ssn1x\\Dropbox\\EBAY\\awef.jpg',
    'C:\\Users\\ssn1x\\Dropbox\\EBAY\\asd32q.jpg',
    'C:\\Users\\ssn1x\\Dropbox\\EBAY\\awefawed.jpg'
  // Add paths to 2-3 different product images here
  // e.g., './tmp/test-image-1.jpg',
  //       './tmp/test-image-2.jpg',
];''

if (testImages.length === 0) {
  console.log('\nUsage: Add image paths to the testImages array');
  console.log('Example:');
  console.log("  const testImages = ['./image1.jpg', './image2.jpg'];");
  process.exit(1);
}

const embeddings = [];
for (const img of testImages) {
  const emb = await testImage(img);
  embeddings.push(emb);
}

// Compare embeddings
if (embeddings.length >= 2 && embeddings[0] && embeddings[1]) {
  console.log('\n' + '='.repeat(60));
  console.log('SIMILARITY TEST');
  console.log('='.repeat(60));
  
  // Normalize to unit vectors
  function toUnit(v) {
    let n = 0;
    for (const x of v) n += x * x;
    if (!n) return v;
    const inv = 1 / Math.sqrt(n);
    return v.map(x => x * inv);
  }
  
  const u1 = toUnit(embeddings[0]);
  const u2 = toUnit(embeddings[1]);
  
  // Compute cosine similarity
  let dot = 0;
  for (let i = 0; i < u1.length; i++) {
    dot += u1[i] * u2[i];
  }
  
  console.log(`\nCosine similarity: ${dot.toFixed(6)}`);
  console.log('\nExpected:');
  console.log('  Different products: 0.2 - 0.7');
  console.log('  Same product: 0.7 - 0.95');
  console.log('  BROKEN (too similar): > 0.98');
  
  if (dot > 0.98) {
    console.log('\n⚠️  WARNING: Embeddings are TOO similar!');
    console.log('This indicates the endpoint is returning nearly identical vectors.');
  } else if (dot > 0.7) {
    console.log('\n✓ Embeddings are similar (expected for same product)');
  } else {
    console.log('\n✓ Embeddings differ (expected for different products)');
  }
}
