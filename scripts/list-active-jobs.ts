/**
 * List all active category fetch jobs
 */

import { tokensStore } from '../src/lib/_blobs.js';

async function main() {
  const store = tokensStore();
  
  console.log('🔍 Checking for active category fetch jobs...\n');
  
  // Get job index
  const index = await store.get('category-fetch-index.json', { type: 'json' }).catch(() => null) as any;
  const activeJobs = (index?.activeJobs || []) as string[];
  
  if (activeJobs.length === 0) {
    console.log('✅ No active jobs found');
    return;
  }
  
  console.log(`📋 Found ${activeJobs.length} active job(s):\n`);
  
  for (const jobId of activeJobs) {
    console.log(`Job ID: ${jobId}`);
    
    // Get status
    const statusKey = `category-fetch-status-${jobId}.json`;
    const status = await store.get(statusKey, { type: 'json' }).catch(() => null) as any;
    
    if (status) {
      console.log(`  Status: ${status.status}`);
      console.log(`  Progress: ${status.processed}/${status.total} (${Math.round((status.processed / status.total) * 100)}%)`);
      console.log(`  Success: ${status.success}, Failed: ${status.failed}`);
      
      const queueKey = `category-fetch-queue-${jobId}.json`;
      const queue = await store.get(queueKey, { type: 'json' }).catch(() => null) as any;
      if (queue) {
        console.log(`  Queue: ${queue.categories?.length || 0} categories`);
      }
      
      const backlogKey = `category-fetch-backlog-${jobId}.json`;
      const backlog = await store.get(backlogKey, { type: 'json' }).catch(() => null) as any;
      if (backlog) {
        console.log(`  Backlog: ${backlog.remaining?.length || 0} categories`);
      }
    }
    
    console.log('');
  }
  
  console.log('\n💡 To clean a job queue, run:');
  console.log(`   tsx scripts/clean-category-queue.ts ${activeJobs[0]}`);
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
