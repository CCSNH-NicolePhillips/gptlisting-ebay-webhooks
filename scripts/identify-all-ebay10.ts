/**
 * Identify ALL products in ebay10 folder - no hints, pure vision
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { searchBrandWebsitePrice } from '../src/lib/openai-websearch.js';

const folder = path.join('testDropbox', 'ebay10');
const files = fs.readdirSync(folder).filter(f => f.endsWith('.jpg')).sort();

async function run() {
  console.log(`\nScanning ${files.length} images in ebay10...\n`);
  
  for (const file of files) {
    const imagePath = path.join(folder, file);
    console.log(`\n=== ${file} ===`);
    
    try {
      // No brand/product hints - let vision identify freely
      const r = await searchBrandWebsitePrice(imagePath);
      console.log(`  Brand: ${r.brand}`);
      console.log(`  Product: ${r.productName}`);
      console.log(`  Price: $${r.price ?? 'N/A'}`);
      console.log(`  Website: ${r.officialWebsite || 'N/A'}`);
      console.log(`  Amazon: ${r.amazonUrl || 'N/A'}`);
    } catch(e: any) { 
      console.log(`  ERROR: ${e.message}`); 
    }
    
    // Rate limit
    await new Promise(r => setTimeout(r, 2500));
  }
  
  console.log('\n\n=== SCAN COMPLETE ===');
}

run();
