#!/usr/bin/env node
/**
 * Clear all job data from Redis (including cached drafts)
 * This forces fresh draft creation with current pricing logic
 * 
 * Usage: node scripts/clear-job-cache.mjs [userId]
 */

import "dotenv/config";

const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

if (!BASE || !TOKEN) {
  console.error("❌ Missing Upstash credentials");
  console.error("Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
  process.exit(1);
}

const userId = process.argv[2]; // Optional: clear only specific user's data

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

async function clearJobCache() {
  console.log("🔍 Scanning for job cache keys...");
  
  // Patterns to clear:
  // - job:* (all jobs)
  // - draft:* (draft-related data if exists)
  const patterns = userId 
    ? [`job:${userId}:*`]
    : ['job:*', 'draft:*'];
  
  let totalKeys = 0;
  let deletedKeys = 0;

  for (const pattern of patterns) {
    console.log(`\n📦 Scanning pattern: ${pattern}`);
    let cursor = "0";
    let patternCount = 0;

    do {
      const scanResult = await redisCall("SCAN", cursor, "MATCH", pattern, "COUNT", "100");
      cursor = scanResult.result[0];
      const keys = scanResult.result[1];

      if (keys.length > 0) {
        console.log(`   Found ${keys.length} keys in batch`);
        patternCount += keys.length;
        totalKeys += keys.length;

        // Delete keys in batches
        for (const key of keys) {
          try {
            await redisCall("DEL", key);
            deletedKeys++;
          } catch (err) {
            console.warn(`   ⚠️ Failed to delete ${key}:`, err.message);
          }
        }
      }
    } while (cursor !== "0");

    if (patternCount > 0) {
      console.log(`   ✓ Cleared ${patternCount} keys for pattern: ${pattern}`);
    }
  }

  console.log(`\n✅ Job cache clear complete:`);
  console.log(`   Total keys found: ${totalKeys}`);
  console.log(`   Keys deleted: ${deletedKeys}`);
  
  if (totalKeys === 0) {
    console.log(`\n💡 Job cache was already empty`);
  } else {
    console.log(`\n💡 Next draft creation will use current pricing logic`);
  }
}

clearJobCache()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Error:", err);
    process.exit(1);
  });
