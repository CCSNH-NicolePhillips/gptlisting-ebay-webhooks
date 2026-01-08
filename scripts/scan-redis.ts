import 'dotenv/config';

const BASE = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '') || '';
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

async function scan(pattern: string) {
  const url = `${BASE}/SCAN/0/MATCH/${encodeURIComponent(pattern)}/COUNT/1000`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  return res.json();
}

async function main() {
  console.log('Scanning for ALL keys...');
  const all = await scan('*');
  const allKeys = all.result?.[1] || [];
  console.log('All keys found:', allKeys.length);
  console.log('Sample keys:', allKeys.slice(0, 30));
  
  console.log('\nScanning for price* keys...');
  const price = await scan('price*');
  console.log('Price keys:', price.result);
  
  console.log('\nScanning for pricecache* keys...');
  const pcache = await scan('pricecache*');
  console.log('Pricecache keys:', pcache.result);
  
  console.log('\nScanning for job* keys...');
  const job = await scan('job*');
  console.log('Job keys:', job.result?.[1]?.length || 0);
}

main();
