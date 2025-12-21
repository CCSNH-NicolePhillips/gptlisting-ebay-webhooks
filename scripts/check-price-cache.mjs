#!/usr/bin/env node
/**
 * Check price cache entries matching a pattern
 * Usage: node scripts/check-price-cache.mjs [pattern]
 */

import "dotenv/config";

const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

if (!BASE || !TOKEN) {
  console.error("❌ Missing Upstash credentials");
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

const pattern = process.argv[2] || "*frog*";
console.log(`🔍 Scanning for price cache keys matching: ${pattern}`);

const scanResult = await redisCall("SCAN", "0", "MATCH", `pricecache:${pattern}`, "COUNT", "100");
const keys = scanResult.result[1];

console.log(`\nFound ${keys.length} matching keys:`);

for (const key of keys) {
  console.log(`\n📦 ${key}`);
  try {
    const data = await redisCall("GET", key);
    if (data.result) {
      const parsed = JSON.parse(data.result);
      console.log(`   MSRP: $${(parsed.msrpCents / 100).toFixed(2)}`);
      console.log(`   Source: ${parsed.chosen?.source}`);
      console.log(`   Notes: ${parsed.chosen?.notes}`);
      console.log(`   Cached: ${new Date(parsed.ts).toISOString()}`);
    }
  } catch (err) {
    console.log(`   Error reading: ${err.message}`);
  }
}
