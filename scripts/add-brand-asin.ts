#!/usr/bin/env tsx
/**
 * Add a brand + ASIN to the brand registry
 * Usage: tsx scripts/add-brand-asin.ts "Brand Name" "Product Name" "ASINCODE"
 */

import "dotenv/config";
import { saveAmazonAsin } from "../src/lib/brand-registry.js";

const [brand, product, asin] = process.argv.slice(2);

if (!brand || !product || !asin) {
  console.error("Usage: tsx scripts/add-brand-asin.ts \"Brand\" \"Product\" \"ASIN\"");
  console.error("Example: tsx scripts/add-brand-asin.ts \"Needed\" \"Collagen Protein 15.9 oz (450 g)\" \"B0C9XYZABC\"");
  process.exit(1);
}

console.log(`Adding to brand registry:`);
console.log(`  Brand: ${brand}`);
console.log(`  Product: ${product}`);
console.log(`  ASIN: ${asin}`);
console.log(`  URL: https://www.amazon.com/dp/${asin}`);

await saveAmazonAsin(brand, product, asin, true);

console.log("\n✅ Added successfully!");
console.log("This product will now use the registered ASIN for pricing.");
