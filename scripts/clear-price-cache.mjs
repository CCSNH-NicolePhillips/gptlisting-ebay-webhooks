import 'dotenv/config';

const BASE = process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, '');
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCall(parts) {
  const url = `${BASE}/${parts.map(p => encodeURIComponent(p)).join('/')}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  return res.json();
}

// Scan for all pricecache keys
const scanResult = await redisCall(['SCAN', '0', 'MATCH', 'pricecache:*', 'COUNT', '1000']);
console.log('Found price cache keys:', scanResult.result);

const keys = scanResult.result?.[1] || [];
console.log(`\nDeleting ${keys.length} price cache entries...`);

for (const key of keys) {
  await redisCall(['DEL', key]);
  console.log(`Deleted: ${key}`);
}

console.log('\n Price cache cleared!');
