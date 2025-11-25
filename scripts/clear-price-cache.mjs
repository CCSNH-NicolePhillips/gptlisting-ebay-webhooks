#!/usr/bin/env node
/**
 * Clear all price cache entries from Redis
 * This forces fresh marketplace searches on next draft creation
 * 
 * Usage: node scripts/clear-price-cache.mjs
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

async function clearPriceCache() {
  console.log("🔍 Scanning for price cache keys...");
  
  // Scan for all keys matching pricecache:*
  let cursor = "0";
  let totalKeys = 0;
  let deletedKeys = 0;

  do {
    const scanResult = await redisCall("SCAN", cursor, "MATCH", "pricecache:*", "COUNT", "100");
    cursor = scanResult.result[0];
    const keys = scanResult.result[1];

    if (keys.length > 0) {
      console.log(`📦 Found ${keys.length} keys in batch`);
      totalKeys += keys.length;

      // Delete keys in batches
      for (const key of keys) {
        try {
          await redisCall("DEL", key);
          deletedKeys++;
        } catch (err) {
          console.warn(`⚠️ Failed to delete ${key}:`, err.message);
        }
      }
    }
  } while (cursor !== "0");

  console.log(`\n✅ Cache clear complete:`);
  console.log(`   Total keys found: ${totalKeys}`);
  console.log(`   Keys deleted: ${deletedKeys}`);
  
  if (totalKeys === 0) {
    console.log(`\n💡 Price cache was already empty`);
  } else {
    console.log(`\n💡 Next draft creation will perform fresh marketplace searches`);
  }
}

clearPriceCache()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Error:", err);
    process.exit(1);
  });
