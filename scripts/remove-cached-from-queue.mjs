/**
 * Query Upstash Redis for all cached category IDs,
 * then remove them from the active job queue
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
config({ path: join(__dirname, '..', 'prod.env') });

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const NETLIFY_TOKEN = process.env.NETLIFY_API_TOKEN;
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID;

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error('❌ Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN in prod.env');
  process.exit(1);
}

if (!NETLIFY_TOKEN || !NETLIFY_SITE_ID) {
  console.error('❌ Missing NETLIFY_API_TOKEN or NETLIFY_SITE_ID in prod.env');
  console.error('\n💡 To get these values:');
  console.error('   1. NETLIFY_API_TOKEN: https://app.netlify.com/user/applications/personal');
  console.error('   2. NETLIFY_SITE_ID: https://app.netlify.com/sites/YOUR-SITE/settings/general#site-details');
  console.error('      Look for "API ID" - it\'s a UUID like abc123-def456-...');
  process.exit(1);
}

// Upstash Redis REST API
async function redisCall(command, args = []) {
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

// Netlify Blobs API
async function blobGet(key) {
  const url = `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/blobs/${key}`;
  
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${NETLIFY_TOKEN}` },
  });
  
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Blob GET ${res.status}: ${await res.text()}`);
  }
  
  return await res.json();
}

async function blobSet(key, value) {
  const url = `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/blobs/${key}`;
  
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${NETLIFY_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(value),
  });
  
  if (!res.ok) {
    throw new Error(`Blob PUT ${res.status}: ${await res.text()}`);
  }
}

// Step 1: Get all cached category IDs from Upstash Redis
async function getAllCachedCategoryIds() {
  console.log('🔍 Scanning Upstash Redis for all cached category IDs...\n');
  
  const cachedIds = new Set();
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
          process.stdout.write(`\r  Found ${totalKeys} cached categories...`);
        }
      }
    }
  } while (cursor !== '0');
  
  console.log(`\r✅ Found ${cachedIds.size} cached category IDs in Upstash Redis\n`);
  return cachedIds;
}

// Step 2: Get active job ID
async function getActiveJobId() {
  console.log('🔍 Looking for active category fetch job...\n');
  
  const index = await blobGet('ebay_tokens_prod:category-fetch-index.json');
  const activeJobs = index?.activeJobs || [];
  
  if (activeJobs.length === 0) {
    console.log('❌ No active jobs found');
    return null;
  }
  
  console.log(`✅ Found active job: ${activeJobs[0]}\n`);
  return activeJobs[0];
}

// Step 3: Clean the queue
async function cleanQueue(jobId, cachedIds) {
  console.log(`🧹 Cleaning queue for job ${jobId}...\n`);
  
  // Get queue
  const queueKey = `ebay_tokens_prod:category-fetch-queue-${jobId}.json`;
  const queue = await blobGet(queueKey);
  
  if (!queue || !Array.isArray(queue.categories)) {
    console.log('❌ Queue not found or invalid');
    return;
  }
  
  const originalLength = queue.categories.length;
  console.log(`📋 Queue has ${originalLength} categories`);
  
  // Filter out cached categories
  const filtered = queue.categories.filter(cat => !cachedIds.has(cat.id));
  const removed = originalLength - filtered.length;
  
  console.log(`🗑️  Removing ${removed} already-cached categories`);
  console.log(`✅ Keeping ${filtered.length} uncached categories\n`);
  
  if (removed > 0) {
    queue.categories = filtered;
    await blobSet(queueKey, queue);
    console.log('💾 Updated queue saved\n');
  }
  
  // Also check backlog
  const backlogKey = `ebay_tokens_prod:category-fetch-backlog-${jobId}.json`;
  const backlog = await blobGet(backlogKey);
  
  if (backlog && Array.isArray(backlog.remaining)) {
    const backlogOriginal = backlog.remaining.length;
    backlog.remaining = backlog.remaining.filter(cat => !cachedIds.has(cat.id));
    const backlogRemoved = backlogOriginal - backlog.remaining.length;
    
    console.log(`📋 Backlog has ${backlogOriginal} categories`);
    console.log(`🗑️  Removing ${backlogRemoved} already-cached categories`);
    console.log(`✅ Keeping ${backlog.remaining.length} uncached categories\n`);
    
    if (backlogRemoved > 0) {
      await blobSet(backlogKey, backlog);
      console.log('💾 Updated backlog saved\n');
    }
  }
  
  // Update status
  const statusKey = `ebay_tokens_prod:category-fetch-status-${jobId}.json`;
  const status = await blobGet(statusKey);
  
  if (status) {
    const newTotal = status.processed + filtered.length + (backlog?.remaining?.length || 0);
    console.log(`📊 Updating total: ${status.total} → ${newTotal}`);
    status.total = newTotal;
    await blobSet(statusKey, status);
    console.log('💾 Updated status saved\n');
  }
  
  console.log('✅ Queue cleanup complete!');
  console.log(`\n💰 Cost savings: ~${removed} eBay API calls prevented`);
}

// Main
async function main() {
  console.log('🚀 Starting queue cleanup...\n');
  
  try {
    // Step 1: Get all cached IDs from Upstash
    const cachedIds = await getAllCachedCategoryIds();
    
    if (cachedIds.size === 0) {
      console.log('⚠️  No cached categories found - nothing to clean');
      return;
    }
    
    // Step 2: Get active job
    const jobId = await getActiveJobId();
    
    if (!jobId) {
      console.log('\n💡 No active job to clean');
      return;
    }
    
    // Step 3: Clean the queue
    await cleanQueue(jobId, cachedIds);
    
    console.log('\n✅ All done! You can now resume the job - it will skip cached categories.');
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
  }
}

main();
