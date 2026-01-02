/**
 * Scan ALL ebay10 images and write results to file
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { searchBrandWebsitePrice } from '../src/lib/openai-websearch.js';

const folder = path.join('testDropbox', 'ebay10');
const files = fs.readdirSync(folder).filter(f => f.endsWith('.jpg')).sort();

async function run() {
  const results: string[] = [];
  results.push(`Scanning ${files.length} images in ebay10...\n`);
  results.push('=' .repeat(60) + '\n');
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const imagePath = path.join(folder, file);
    
    console.log(`[${i+1}/${files.length}] Processing ${file}...`);
    results.push(`\n=== ${file} ===\n`);
    
    try {
      const r = await searchBrandWebsitePrice(imagePath);
      results.push(`  Brand: ${r.brand}\n`);
      results.push(`  Product: ${r.productName}\n`);
      results.push(`  Price: $${r.price ?? 'N/A'}\n`);
      results.push(`  Website: ${r.officialWebsite || 'N/A'}\n`);
      results.push(`  Amazon: ${r.amazonUrl || 'N/A'}\n`);
      results.push(`  Confidence: ${r.confidence}\n`);
    } catch(e: any) { 
      results.push(`  ERROR: ${e.message}\n`);
    }
    
    // Rate limit
    await new Promise(r => setTimeout(r, 3000));
  }
  
  results.push('\n\n=== SCAN COMPLETE ===\n');
  
  // Write to file
  fs.writeFileSync('ebay10-vision-scan.txt', results.join(''));
  console.log('\nResults written to ebay10-vision-scan.txt');
}

run().catch(console.error);
