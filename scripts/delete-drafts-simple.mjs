#!/usr/bin/env node
/**
 * Simplified draft deletion - just needs your eBay refresh token
 * 
 * To get your refresh token:
 * 1. Go to https://draftpilot.app
 * 2. Open DevTools (F12)
 * 3. Go to Application > Local Storage > https://draftpilot.app
 * 4. Find the Auth0 token or run this in console:
 *    
 *    fetch('/.netlify/functions/ebay-get-token', {
 *      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('your_auth_token_key') }
 *    }).then(r => r.json()).then(d => console.log('Refresh token:', d.refresh_token))
 * 
 * OR just paste your refresh token here:
 */

const REFRESH_TOKEN = process.argv[2];
const APP_ID = process.env.EBAY_APP_ID || 'YOUR_APP_ID';
const CERT_ID = process.env.EBAY_CERT_ID || 'YOUR_CERT_ID';

if (!REFRESH_TOKEN) {
	console.error('Usage: node scripts/delete-drafts-simple.mjs YOUR_REFRESH_TOKEN');
	console.error('\nGet your refresh token from eBay or your Netlify function logs');
	process.exit(1);
}

const API_HOST = 'https://api.ebay.com';

async function getAccessToken() {
	const auth = Buffer.from(`${APP_ID}:${CERT_ID}`).toString('base64');
	const body = `grant_type=refresh_token&refresh_token=${REFRESH_TOKEN}`;
	
	const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'Authorization': `Basic ${auth}`
		},
		body
	});
	
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Token refresh failed: ${res.status} ${text}`);
	}
	
	const json = await res.json();
	return json.access_token;
}

async function listInventory(accessToken, offset = 0, limit = 200) {
	const url = `${API_HOST}/sell/inventory/v1/inventory_item?offset=${offset}&limit=${limit}`;
	const res = await fetch(url, {
		headers: { 'Authorization': `Bearer ${accessToken}` }
	});
	
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`List inventory failed: ${res.status} ${text}`);
	}
	
	const json = await res.json();
	return {
		items: json.inventoryItems || [],
		total: json.total || 0,
		next: json.next
	};
}

async function deleteInventoryItem(accessToken, sku) {
	const url = `${API_HOST}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
	const res = await fetch(url, {
		method: 'DELETE',
		headers: { 'Authorization': `Bearer ${accessToken}` }
	});
	
	return res.ok;
}

async function main() {
	console.log('🔑 Getting eBay access token...');
	const accessToken = await getAccessToken();
	console.log('✅ Got access token\n');
	
	let offset = 0;
	let totalDeleted = 0;
	let hasMore = true;
	
	while (hasMore) {
		console.log(`📋 Fetching inventory batch (offset=${offset})...`);
		const { items, total, next } = await listInventory(accessToken, offset);
		console.log(`   Found ${items.length} items (total: ${total})\n`);
		
		if (!items.length) {
			hasMore = false;
			break;
		}
		
		for (const item of items) {
			const sku = item.sku;
			process.stdout.write(`   Deleting ${sku}... `);
			
			const success = await deleteInventoryItem(accessToken, sku);
			if (success) {
				console.log('✅');
				totalDeleted++;
			} else {
				console.log('❌');
			}
			
			// Small delay to avoid rate limits
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		
		if (!next) {
			hasMore = false;
		} else {
			offset += items.length;
		}
	}
	
	console.log('\n' + '='.repeat(60));
	console.log(`✅ Deleted ${totalDeleted} inventory items total`);
	console.log('='.repeat(60));
}

main().catch(err => {
	console.error('\n❌ Error:', err.message);
	process.exit(1);
});
