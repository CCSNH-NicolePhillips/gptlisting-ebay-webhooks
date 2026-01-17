#!/usr/bin/env tsx
import 'dotenv/config';

/**
 * Check the status of a SmartDrafts job.
 * 
 * Usage: npx tsx scripts/check-job-status.ts <jobId>
 * 
 * Uses hardcoded userId for convenience.
 */

const DEFAULT_USER_ID = 'google-oauth2|108767599998494531403';

async function main() {
  const jobId = process.argv[2];

  if (!jobId) {
    console.error('Usage: npx tsx scripts/check-job-status.ts <jobId>');
    process.exit(1);
  }

  const userId = DEFAULT_USER_ID;

  console.log(`Checking job status for user=${userId}, jobId=${jobId}...\n`);

  const { getJob, listJobs } = await import('../src/lib/job-store.js');
  const { k } = await import('../src/lib/user-keys.js');
  
  // Try user-scoped key first, then fallback to just jobId
  const scopedKey = k.job(userId, jobId);
  console.log(`Trying key: ${scopedKey}`);
  let job = await getJob(jobId, { key: scopedKey });
  
  if (!job) {
    // Try without user scoping
    console.log(`Trying fallback key: job:${jobId}`);
    job = await getJob(jobId);
  }
  
  if (!job) {
    // List recent jobs to see what's there
    console.log('\nListing recent jobs...');
    const recentJobs = await listJobs(10);
    console.log('Recent jobs:', JSON.stringify(recentJobs, null, 2));
  }

  if (!job) {
    console.error('Job not found!');
    process.exit(1);
  }

  console.log('=== JOB STATUS ===');
  console.log('State:', job.state);
  console.log('Total Products:', job.totalProducts);
  console.log('Processed Products:', job.processedProducts);
  console.log('Started At:', job.startedAt ? new Date(job.startedAt).toISOString() : 'N/A');
  console.log('Finished At:', job.finishedAt ? new Date(job.finishedAt).toISOString() : 'N/A');
  
  if (job.startedAt && job.finishedAt) {
    const duration = (job.finishedAt - job.startedAt) / 1000;
    console.log('Duration:', `${duration.toFixed(1)}s`);
  }

  if (job.drafts && job.drafts.length > 0) {
    console.log('\n=== DRAFTS CREATED ===');
    console.log(`Count: ${job.drafts.length}`);
    for (const draft of job.drafts) {
      console.log(`  - ${draft.sku}: ${draft.title?.substring(0, 50)}... @ $${draft.price?.toFixed(2)}`);
      if (draft.attentionReasons && draft.attentionReasons.length > 0) {
        for (const reason of draft.attentionReasons) {
          console.log(`      ⚠️ ${reason.code}: ${reason.message}`);
        }
      }
    }
  }

  if (job.errors && job.errors.length > 0) {
    console.log('\n=== ERRORS ===');
    console.log(`Count: ${job.errors.length}`);
    for (const error of job.errors) {
      console.log(`  - ${error.productId}: ${error.error}`);
    }
  }

  if (job.error) {
    console.log('\n=== JOB ERROR ===');
    console.log(job.error);
  }
}

main().catch(console.error);
