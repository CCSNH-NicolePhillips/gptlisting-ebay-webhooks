#!/usr/bin/env node

const BASE = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!BASE || !TOKEN) {
  console.error('❌ Missing Upstash credentials');
  process.exit(1);
}

async function redisCall(...parts) {
  const encoded = parts.map(part => encodeURIComponent(part));
  const url = `${BASE}/${encoded.join("/")}`;
  
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis error ${res.status}: ${text}`);
  }
  
  return res.json();
}

const now = new Date();
const month = String(now.getUTCMonth() + 1).padStart(2, "0");
const yearMonth = `${now.getUTCFullYear()}-${month}`;

console.log(`\n📊 API Usage for ${yearMonth}:\n`);

// Check SerpAPI quota
const serpKey = `pricequota:serpapi:${yearMonth}`;
const serpCount = await redisCall("GET", serpKey);
const serpUsed = Number(serpCount?.result ?? 0);
const serpLimit = Number(process.env.PRICE_QUOTA_SERPAPI ?? 250);
console.log(`🔍 SerpAPI: ${serpUsed} / ${serpLimit} calls (${((serpUsed/serpLimit)*100).toFixed(1)}%)`);

// Check Brave quota
const braveKey = `pricequota:brave:${yearMonth}`;
const braveCount = await redisCall("GET", braveKey);
const braveUsed = Number(braveCount?.result ?? 0);
const braveLimit = Number(process.env.PRICE_QUOTA_BRAVE ?? 2000);
console.log(`🔍 Brave: ${braveUsed} / ${braveLimit} calls (${((braveUsed/braveLimit)*100).toFixed(1)}%)`);

console.log('\n');

if (serpUsed >= serpLimit) {
  console.log('⚠️  SerpAPI quota exhausted!');
}

if (braveUsed >= braveLimit) {
  console.log('⚠️  Brave quota exhausted!');
}
