/**
 * Reset stuck category fetch job
 * Run with: npx tsx scripts/reset-category-job.ts <jobId>
 */

import { cacheStore } from '../src/lib/redis-store.js';

const jobId = process.argv[2];
if (!jobId) {
  console.error('Usage: npx tsx scripts/reset-category-job.ts <jobId>');
  process.exit(1);
}

const store = cacheStore();

async function resetJob() {
  try {
    const lockKey = `category-fetch-lock-${jobId}.json`;
    const statusKey = `category-fetch-status-${jobId}.json`;
    
    // Delete the lock
    await store.delete(lockKey);
    console.log(`✓ Deleted lock: ${lockKey}`);
    
    // Get current status
    const status = await store.get(statusKey, { type: 'json' }) as any;
    if (status) {
      console.log('Current status:', status);
    }
    
    // Remove from active jobs
    const index = await store.get('category-fetch-index.json', { type: 'json' }) as any;
    if (index?.activeJobs) {
      const activeJobs = (index.activeJobs as string[]).filter(id => id !== jobId);
      await store.set('category-fetch-index.json', JSON.stringify({ activeJobs }));
      console.log(`✓ Removed ${jobId} from active jobs`);
    }
    
    console.log('\nJob reset complete. You can now start a new fetch.');
  } catch (err) {
    console.error('Error resetting job:', err);
    process.exit(1);
  }
}

resetJob();
