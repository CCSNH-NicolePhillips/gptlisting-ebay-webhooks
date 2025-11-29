#!/usr/bin/env node
/**
 * Extract eBay refresh token from Upstash for local use
 * 
 * Usage:
 *   node scripts/get-ebay-token.mjs
 * 
 * Requires environment variables:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *   
 * Run this to get your EBAY_REFRESH_TOKEN, then use it with delete-all-drafts.mjs
 */

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
	console.error('❌ Missing environment variables. Need: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN');
	console.error('\nThese should be in your prod.env file or netlify environment.');
	process.exit(1);
}

async function main() {
	console.log('🔍 Searching for eBay tokens in Upstash...\n');
	
	// List all keys
	const keysRes = await fetch(`${UPSTASH_URL}/keys/*`, {
		headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
	});
	
	const keysData = await keysRes.json();
	const keys = keysData.result || [];
	
	console.log(`Found ${keys.length} total keys in Upstash`);
	
	// Find keys that look like user tokens
	const ebayKeys = keys.filter(k => k.includes('ebay.json'));
	console.log(`Found ${ebayKeys.length} eBay token key(s):\n`);
	
	for (const key of ebayKeys) {
		console.log(`  Key: ${key}`);
		
		// Get the token data
		const getRes = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
			headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
		});
		
		const getData = await getRes.json();
		const tokenData = JSON.parse(getData.result);
		
		if (tokenData.refresh_token) {
			console.log(`  ✅ Refresh Token: ${tokenData.refresh_token}\n`);
			console.log('To use this token, run:\n');
			console.log(`$env:EBAY_REFRESH_TOKEN="${tokenData.refresh_token}"`);
			console.log(`$env:EBAY_APP_ID="${process.env.EBAY_APP_ID || 'YOUR_APP_ID'}"`);
			console.log(`$env:EBAY_CERT_ID="${process.env.EBAY_CERT_ID || 'YOUR_CERT_ID'}"`);
			console.log(`node scripts/delete-all-drafts.mjs\n`);
		} else {
			console.log(`  ❌ No refresh_token found\n`);
		}
	}
}

main().catch(err => {
	console.error('❌ Error:', err);
	process.exit(1);
});
