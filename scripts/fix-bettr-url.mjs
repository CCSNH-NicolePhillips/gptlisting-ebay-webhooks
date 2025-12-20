#!/usr/bin/env node
/**
 * Fix bettr brand URL in Redis brand-map
 * Points bettr products to the correct performbettr.com URL with MSRP $69.99
 * 
 * Usage: node scripts/fix-bettr-url.mjs
 */

import "dotenv/config";

const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

if (!BASE || !TOKEN) {
  console.error("❌ Missing Upstash credentials");
  console.error("Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
  process.exit(1);
}

async function redisCall(...parts) {
  const encoded = parts.map((part) => encodeURIComponent(part));
  const url = `${BASE}/${encoded.join("/")}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis error ${res.status}: ${text}`);
  }

  return res.json();
}

async function fixBettrUrl() {
  console.log("🔧 Setting correct bettr brand URL in Redis...\n");
  
  // Signature format matches price-lookup.ts: brand.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  // "bettr." becomes "bettr", "Morning" becomes "morning"
  const signatures = [
    "bettr morning",           // Most common: "bettr" + "Morning"
    "bettr morning strawberry mango", // Full product name
    "bettr",                   // Just brand name fallback
  ];
  
  const correctUrl = "https://performbettr.com/products/bettr-morning";
  
  const brandUrls = {
    brand: correctUrl,
    lastChecked: Date.now(),
    notes: "Correct URL for bettr. Morning (MSRP $69.99), not bettr.com homepage"
  };
  
  console.log(`✅ Correct URL: ${correctUrl}`);
  console.log(`   (MSRP: $69.99, discounted to ~$62.99)\n`);
  
  for (const sig of signatures) {
    const key = `brandmap:${sig}`;
    console.log(`📝 Setting ${key}...`);
    
    try {
      await redisCall("SET", key, JSON.stringify(brandUrls));
      console.log(`   ✓ Saved`);
    } catch (err) {
      console.error(`   ❌ Failed:`, err.message);
    }
  }
  
  console.log(`\n💡 Now clear price cache to force fresh lookup:`);
  console.log(`   node scripts/clear-price-cache.mjs\n`);
  console.log(`💡 Next draft creation will use performbettr.com URL\n`);
}

fixBettrUrl()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Error:", err);
    process.exit(1);
  });
