#!/usr/bin/env tsx
/**
 * One-shot: delete all Redis keys that contain a given draft/job ID.
 * Usage:  npx tsx scripts/delete-draft-by-id.ts BMLBOmml7juhgh0q
 */
import 'dotenv/config';

const BASE = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

if (!BASE || !TOKEN) {
  console.error('❌ Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  process.exit(1);
}

async function redisCall(...parts: string[]): Promise<{ result: unknown }> {
  const encoded = parts.map((p) => encodeURIComponent(p));
  const url = `${BASE}/${encoded.join('/')}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis ${res.status}: ${text}`);
  }
  return res.json() as Promise<{ result: unknown }>;
}

async function main() {
  const targetId = process.argv[2];
  if (!targetId) {
    console.error('Usage: npx tsx scripts/delete-draft-by-id.ts <draftId>');
    process.exit(1);
  }

  console.log(`\nSearching Redis for keys matching *${targetId}*\n`);

  const resp = await redisCall('KEYS', `*${targetId}*`);
  const keys = Array.isArray(resp.result) ? (resp.result as string[]) : [];

  if (keys.length === 0) {
    console.log('No keys found matching that ID.');
    return;
  }

  console.log(`Found ${keys.length} key(s):`);
  for (const key of keys) {
    console.log(`  • ${key}`);
  }

  console.log('\nDeleting...');
  let deleted = 0;
  for (const key of keys) {
    try {
      await redisCall('DEL', key);
      console.log(`  ✅ Deleted: ${key}`);
      deleted++;
    } catch (err) {
      console.error(`  ❌ Failed to delete ${key}:`, err);
    }
  }

  console.log(`\nDone. ${deleted}/${keys.length} keys deleted.\n`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
