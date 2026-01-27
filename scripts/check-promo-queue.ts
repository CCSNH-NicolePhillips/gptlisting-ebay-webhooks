#!/usr/bin/env npx tsx
/**
 * Check promotion queue status
 */

import 'dotenv/config';
import { getQueueStats, getReadyJobs } from '../src/lib/promotion-queue.js';

async function main() {
  console.log('='.repeat(60));
  console.log('PROMOTION QUEUE STATUS');
  console.log('='.repeat(60));
  
  try {
    const stats = await getQueueStats();
    console.log('\nQueue Stats:', stats);
    
    const readyJobs = await getReadyJobs(50);
    console.log('\nReady Jobs:', readyJobs.length);
    
    if (readyJobs.length > 0) {
      console.log('\nReady Jobs Details:');
      for (const job of readyJobs) {
        console.log(`  - Job ${job.id}: listing=${job.listingId}, attempts=${job.attempts}/${job.maxAttempts}, nextRetry=${new Date(job.nextRetryAt).toISOString()}`);
        if (job.lastError) {
          console.log(`      Last Error: ${job.lastError}`);
        }
      }
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
