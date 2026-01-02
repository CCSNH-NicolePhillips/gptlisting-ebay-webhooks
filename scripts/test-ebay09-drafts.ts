#!/usr/bin/env tsx
/**
 * Test complete draft creation pipeline on ebay09 folder
 * This runs: scan → pairing → draft creation with pricing
 */

import { config } from "dotenv";
import * as fs from 'fs';
import * as path from 'path';
import { classifyImagesBatch, pairFromClassifications } from '../src/smartdrafts/pairing-v2-core.js';

config();

async function testEbay09Drafts() {
  console.log("🧪 Testing ebay09 folder: scan → pairing → drafts with pricing\n");
  
  const testDir = path.join(process.cwd(), 'testDropbox', 'ebay09');
  const files = fs.readdirSync(testDir)
    .filter(f => f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png'))
    .sort();
  
  console.log(`📁 Found ${files.length} images in ebay09\n`);
  
  const imagePaths = files.map(f => path.join(testDir, f));
  
  // STEP 1: Classify images
  console.log('=== STEP 1: Classification ===\n');
  const classifications = await classifyImagesBatch(imagePaths);
  
  console.log(`✓ Classified ${classifications.length} images\n`);
  
  // STEP 2: Pair fronts/backs
  console.log('=== STEP 2: Pairing ===\n');
  const pairingOutput = await pairFromClassifications(classifications);
  
  console.log(`✓ Found ${pairingOutput.pairs.length} pairs`);
  console.log(`✓ Found ${pairingOutput.unpaired.length} unpaired items\n`);
  
  // STEP 3: Create drafts with pricing
  console.log('=== STEP 3: Draft Creation with Pricing ===\n');
  
  // For each pair, get the product data from classifications and test pricing
  for (const pair of pairingOutput.pairs) {
    // Find the front image classification data
    const frontData = classifications.find(c => c.filename === pair.front);
    if (!frontData) {
      console.error(`Could not find classification data for ${pair.front}`);
      continue;
    }
    
    console.log(`\n${'='.repeat(80)}`);
    console.log(`Product: ${frontData.brand} - ${frontData.productName}`);
    console.log('='.repeat(80));
    
    // Test price lookup directly
    const { lookupPrice } = await import('../src/lib/price-lookup.js');
    
    const priceInput = {
      brand: frontData.brand || 'Unknown',
      title: frontData.productName || '',
      categoryId: '1234', // placeholder
      packQty: frontData.packCount || 1,
      keyText: frontData.keyText,
      categoryPath: frontData.categoryPath,
      netWeight: frontData.netWeight
    };
    
    console.log(`\n🔍 Looking up price for:`);
    console.log(`   Brand: ${priceInput.brand}`);
    console.log(`   Title: ${priceInput.title}`);
    
    try {
      const priceDecision = await lookupPrice(priceInput);
      
      console.log(`\n💰 Price Decision:`);
      console.log(`   Source: ${priceDecision.source}`);
      console.log(`   Reason: ${priceDecision.reason}`);
      console.log(`   Price: $${priceDecision.price.toFixed(2)}`);
      console.log(`   Confidence: ${priceDecision.confidence}`);
      
      if (priceDecision.amazonUrl) {
        console.log(`   Amazon URL: ${priceDecision.amazonUrl}`);
      }
      if (priceDecision.brandUrl) {
        console.log(`   Brand URL: ${priceDecision.brandUrl}`);
      }
      
      // Show weight if available
      if (priceDecision.amazonWeight) {
        console.log(`   ⚖️  Weight: ${priceDecision.amazonWeight.value} ${priceDecision.amazonWeight.unit}`);
      }
      
    } catch (error: any) {
      console.error(`\n❌ Price lookup failed: ${error.message}`);
    }
  }
  
  console.log(`\n\n${'='.repeat(80)}`);
  console.log('✅ Test complete');
  console.log('='.repeat(80));
}

testEbay09Drafts().catch(console.error);
