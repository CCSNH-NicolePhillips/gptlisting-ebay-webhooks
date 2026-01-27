/**
 * Clean category fetch queue by removing already-cached categories
 * This prevents wasting money re-fetching categories we already have
 */

import { tokensStore } from '../src/lib/redis-store.js';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  process.exit(1);
}

async function redisCall(command: string, args: any[] = []): Promise<any> {
  const path = [command.toLowerCase(), ...args.map(encodeURIComponent)].join('/');
  const url = `${UPSTASH_URL}/${path}`;
  
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  
  if (!res.ok) {
    throw new Error(`Redis ${res.status}: ${await res.text()}`);
  }
  
  const data = await res.json();
  return data?.result ?? null;
}

async function getAllCachedCategoryIds(): Promise<Set<string>> {
  console.log('🔍 Scanning Redis for all cached category IDs...');
  
  const cachedIds = new Set<string>();
  let cursor = '0';
  let totalKeys = 0;
  
  do {
    // Scan for taxonomy:id:* keys
    const result = await redisCall('scan', [cursor, 'MATCH', 'taxonomy:id:*', 'COUNT', '100']);
    cursor = String(result[0]);
    const keys = result[1] || [];
    
    for (const key of keys) {
      // Extract ID from "taxonomy:id:12345"
      const id = key.replace('taxonomy:id:', '');
      if (id) {
        cachedIds.add(id);
        totalKeys++;
        
        if (totalKeys % 100 === 0) {
          console.log(`  Found ${totalKeys} cached categories...`);
        }
      }
    }
  } while (cursor !== '0');
  
  console.log(`✅ Found ${cachedIds.size} cached category IDs in Redis`);
  return cachedIds;
}

async function cleanQueue(jobId: string, cachedIds: Set<string>): Promise<void> {
  const store = tokensStore();
  
  console.log(`\n🧹 Cleaning queue for job ${jobId}...`);
  
  // Get the queue
  const queueKey = `category-fetch-queue-${jobId}.json`;
  const queue = await store.get(queueKey, { type: 'json' }) as any;
  
  if (!queue || !Array.isArray(queue.categories)) {
    console.log('❌ Queue not found or empty');
    return;
  }
  
  const originalLength = queue.categories.length;
  console.log(`📋 Queue has ${originalLength} categories`);
  
  // Filter out categories we already have
  const filtered = queue.categories.filter((cat: any) => !cachedIds.has(cat.id));
  const removed = originalLength - filtered.length;
  
  console.log(`🗑️  Removing ${removed} already-cached categories`);
  console.log(`✅ Keeping ${filtered.length} uncached categories`);
  
  if (removed > 0) {
    queue.categories = filtered;
    await store.setJSON(queueKey, queue);
    console.log('💾 Updated queue saved');
  } else {
    console.log('✅ Queue already clean - no duplicates found');
  }
  
  // Also check backlog
  const backlogKey = `category-fetch-backlog-${jobId}.json`;
  const backlog = await store.get(backlogKey, { type: 'json' }).catch(() => null) as any;
  
  if (backlog && Array.isArray(backlog.remaining)) {
    const backlogOriginal = backlog.remaining.length;
    backlog.remaining = backlog.remaining.filter((cat: any) => !cachedIds.has(cat.id));
    const backlogRemoved = backlogOriginal - backlog.remaining.length;
    
    console.log(`\n🗑️  Backlog: Removing ${backlogRemoved} already-cached categories`);
    console.log(`✅ Backlog: Keeping ${backlog.remaining.length} uncached categories`);
    
    if (backlogRemoved > 0) {
      await store.setJSON(backlogKey, backlog);
      console.log('💾 Updated backlog saved');
    }
  }
  
  // Update status
  const statusKey = `category-fetch-status-${jobId}.json`;
  const status = await store.get(statusKey, { type: 'json' }).catch(() => null) as any;
  
  if (status) {
    status.total = status.processed + filtered.length + (backlog?.remaining?.length || 0);
    await store.setJSON(statusKey, status);
    console.log(`📊 Updated total to ${status.total}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const jobId = args[0];
  
  if (!jobId) {
    console.error('Usage: tsx scripts/clean-category-queue.ts <jobId>');
    console.error('Example: tsx scripts/clean-category-queue.ts job-1762633596983-3xlzpt11e');
    process.exit(1);
  }
  
  console.log(`🚀 Starting queue cleanup for job: ${jobId}\n`);
  
  // Step 1: Get all cached category IDs from Redis
  const cachedIds = await getAllCachedCategoryIds();
  
  // Step 2: Clean the queue
  await cleanQueue(jobId, cachedIds);
  
  console.log('\n✅ Cleanup complete!');
  console.log('\n💡 Now you can resume the job - it will only fetch uncached categories.');
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
