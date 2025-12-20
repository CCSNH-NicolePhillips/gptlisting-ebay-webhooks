#!/usr/bin/env tsx
/**
 * Find the correct Amazon ASIN for a product
 */

import "dotenv/config";
import { braveFirstUrl } from "../src/lib/search.js";

const brand = process.argv[2] || "Needed";
const product = process.argv[3] || "Collagen Protein 15.9 oz";

console.log(`🔍 Searching Amazon for: ${brand} ${product}\n`);

const query = `${brand} ${product} site:amazon.com`;
const url = await braveFirstUrl(query, 'amazon.com');

if (url) {
  console.log(`✅ Found Amazon URL: ${url}`);
  
  // Extract ASIN from URL
  const asinMatch = url.match(/\/dp\/([A-Z0-9]{10})/i) || url.match(/\/gp\/product\/([A-Z0-9]{10})/i);
  if (asinMatch) {
    console.log(`📦 ASIN: ${asinMatch[1]}`);
  }
} else {
  console.log(`❌ No Amazon URL found`);
}
