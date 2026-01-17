#!/usr/bin/env tsx
import 'dotenv/config';

const jobId = process.argv[2] || '3c3166d1-594e-482b-9148-acf6802d8856';

async function main() {
  // Use fetch to query Upstash REST API directly
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;

  console.log(`Looking for job: ${jobId}\n`);

  // Find the job key using KEYS command
  const keysRes = await fetch(`${url}/keys/job:*:${jobId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const keysData = await keysRes.json() as { result: string[] };
  const keys = keysData.result || [];
  
  if (keys.length === 0) {
    console.log('Job not found in Redis!');
    return;
  }

  console.log('Found key:', keys[0]);
  
  // Extract userId from key pattern job:{userId}:{jobId}
  const parts = keys[0].split(':');
  const userId = parts[1];
  console.log('User ID:', userId);

  // Get job data using GET command
  const jobRes = await fetch(`${url}/get/${encodeURIComponent(keys[0])}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const jobData = await jobRes.json() as { result: string | null };
  
  if (!jobData.result) {
    console.log('Job data is empty!');
    return;
  }

  const job = JSON.parse(jobData.result) as any;

  console.log('\n=== JOB STATUS ===');
  console.log('State:', job.state);
  console.log('Total Products:', job.totalProducts);
  console.log('Processed Products:', job.processedProducts);
  console.log('Started At:', job.startedAt ? new Date(job.startedAt).toISOString() : 'N/A');
  console.log('Finished At:', job.finishedAt ? new Date(job.finishedAt).toISOString() : 'N/A');
  
  if (job.startedAt && job.finishedAt) {
    const duration = (job.finishedAt - job.startedAt) / 1000;
    console.log('Duration:', `${duration.toFixed(1)}s`);
  } else if (job.startedAt) {
    const elapsed = (Date.now() - job.startedAt) / 1000;
    console.log('Elapsed:', `${elapsed.toFixed(1)}s (still running)`);
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
