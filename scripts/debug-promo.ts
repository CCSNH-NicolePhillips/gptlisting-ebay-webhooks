#!/usr/bin/env npx tsx
/**
 * Debug promotion system
 */

import 'dotenv/config';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '') || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

async function redis(cmd: string, ...args: string[]): Promise<any> {
  const url = REDIS_URL + '/' + cmd + '/' + args.map(encodeURIComponent).join('/');
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + REDIS_TOKEN } });
  const data = await res.json();
  return data.result;
}

async function main() {
  console.log('='.repeat(60));
  console.log('PROMOTION SYSTEM DEBUG');
  console.log('='.repeat(60));
  
  // Check Redis connection
  console.log('\n1. Redis Connection:');
  console.log('   URL:', REDIS_URL ? 'configured' : 'MISSING');
  console.log('   Token:', REDIS_TOKEN ? 'configured' : 'MISSING');
  
  if (!REDIS_URL || !REDIS_TOKEN) {
    console.log('\n❌ Redis not configured!');
    return;
  }
  
  // Get all promotion intents
  console.log('\n2. Promotion Intents (promo_intent:*):');
  const intentKeys = await redis('KEYS', 'promo_intent:*');
  console.log('   Found:', intentKeys?.length || 0);
  if (intentKeys?.length > 0) {
    for (const key of intentKeys.slice(0, 10)) {
      const val = await redis('GET', key);
      console.log(`   ${key}: ${val}`);
    }
  }
  
  // Get all promotion jobs
  console.log('\n3. Promotion Jobs (promo_job:*):');
  const jobKeys = await redis('KEYS', 'promo_job:*');
  console.log('   Found:', jobKeys?.length || 0);
  if (jobKeys?.length > 0) {
    for (const key of jobKeys.slice(0, 10)) {
      const val = await redis('GET', key);
      console.log(`   ${key}: ${val}`);
    }
  }
  
  // Get queue
  console.log('\n4. Promotion Queue (promotion_queue):');
  const queueSize = await redis('ZCARD', 'promotion_queue');
  console.log('   Queue size:', queueSize || 0);
  if (queueSize > 0) {
    const items = await redis('ZRANGE', 'promotion_queue', '0', '10', 'WITHSCORES');
    console.log('   Items:', items);
  }
  
  console.log('\n' + '='.repeat(60));
}

main().catch(console.error);
