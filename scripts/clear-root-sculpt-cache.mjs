#!/usr/bin/env node
/**
 * Clear cached price for Root Sculpt
 */

import 'dotenv/config';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  process.exit(1);
}

// Price cache key format: price:brand:product:variant
const key = 'price:root:sculpt:';

console.log(`Deleting cache key: ${key}`);

const response = await fetch(`${UPSTASH_URL}/del/${key}`, {
  headers: {
    Authorization: `Bearer ${UPSTASH_TOKEN}`
  }
});

const result = await response.json();
console.log('Result:', result);

if (result.result === 1) {
  console.log('✅ Cache cleared successfully');
} else {
  console.log('⚠️  Key not found or already deleted');
}
