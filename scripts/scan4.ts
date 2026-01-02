/**
 * Quick scan - first 4 images in ebay10
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { searchBrandWebsitePrice } from '../src/lib/openai-websearch.js';

const folder = path.join('testDropbox', 'ebay10');
const files = fs.readdirSync(folder).filter(f => f.endsWith('.jpg')).sort().slice(0, 4);

async function run() {
  console.log(`Scanning ${files.length} images...\n`);
  
  for (const file of files) {
    const imagePath = path.join(folder, file);
    console.log(`\n=== ${file} ===`);
    
    try {
      const r = await searchBrandWebsitePrice(imagePath);
      console.log(`  Brand: ${r.brand}`);
      console.log(`  Product: ${r.productName}`);
      console.log(`  Price: $${r.price ?? 'N/A'}`);
    } catch(e: any) { 
      console.log(`  ERROR: ${e.message}`); 
    }
    
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('\nDone!');
}

run();
