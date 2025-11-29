#!/usr/bin/env node
/**
 * Local script to delete all unpublished eBay drafts (offers + inventory items)
 * Bypasses Netlify timeout limits
 * 
 * Usage:
 *   node scripts/delete-all-drafts.mjs
 * 
 * Requires environment variables:
 *   EBAY_REFRESH_TOKEN - Your eBay refresh token
 *   EBAY_APP_ID - eBay App ID
 *   EBAY_CERT_ID - eBay Cert ID
 */

import https from 'https';
import { URL } from 'url';

const EBAY_REFRESH_TOKEN = process.env.EBAY_REFRESH_TOKEN;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID;

if (!EBAY_REFRESH_TOKEN || !EBAY_APP_ID || !EBAY_CERT_ID) {
	console.error('❌ Missing environment variables. Need: EBAY_REFRESH_TOKEN, EBAY_APP_ID, EBAY_CERT_ID');
	process.exit(1);
}

const API_HOST = 'https://api.ebay.com';

// Get access token from refresh token
async function getAccessToken() {
	const auth = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT_ID}`).toString('base64');
	const body = `grant_type=refresh_token&refresh_token=${EBAY_REFRESH_TOKEN}`;
	
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

// List inventory items
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
		total: json.total || 0
	};
}

// List offers for a SKU
async function listOffersForSku(accessToken, sku) {
	const url = `${API_HOST}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&limit=50`;
	const res = await fetch(url, {
		headers: { 'Authorization': `Bearer ${accessToken}` }
	});
	
	if (!res.ok) return [];
	const json = await res.json();
	return json.offers || [];
}

// Delete offer
async function deleteOffer(accessToken, offerId) {
	const url = `${API_HOST}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
	const res = await fetch(url, {
		method: 'DELETE',
		headers: { 'Authorization': `Bearer ${accessToken}` }
	});
	
	return res.ok;
}

// Delete inventory item
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
	console.log('✅ Got access token');
	
	console.log('\n📋 Fetching inventory items...');
	const { items, total } = await listInventory(accessToken);
	console.log(`Found ${items.length} items (total: ${total})`);
	
	if (!items.length) {
		console.log('✅ No items to delete');
		return;
	}
	
	let deletedOffers = 0;
	let deletedInventory = 0;
	
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const sku = item.sku;
		
		console.log(`\n[${i + 1}/${items.length}] Processing SKU: ${sku}`);
		
		// Get offers for this SKU
		const offers = await listOffersForSku(accessToken, sku);
		console.log(`  Found ${offers.length} offer(s)`);
		
		// Delete unpublished offers
		for (const offer of offers) {
			const status = (offer.status || '').toUpperCase();
			if (status === 'UNPUBLISHED' || status === 'DRAFT' || status === 'INACTIVE') {
				const success = await deleteOffer(accessToken, offer.offerId);
				if (success) {
					console.log(`  ✅ Deleted offer ${offer.offerId} (${status})`);
					deletedOffers++;
				} else {
					console.log(`  ❌ Failed to delete offer ${offer.offerId}`);
				}
			}
		}
		
		// Delete inventory item
		const success = await deleteInventoryItem(accessToken, sku);
		if (success) {
			console.log(`  ✅ Deleted inventory item ${sku}`);
			deletedInventory++;
		} else {
			console.log(`  ❌ Failed to delete inventory item ${sku}`);
		}
		
		// Rate limiting - wait 100ms between items
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	
	console.log('\n' + '='.repeat(60));
	console.log(`✅ Deletion complete!`);
	console.log(`   Deleted ${deletedOffers} offer(s)`);
	console.log(`   Deleted ${deletedInventory} inventory item(s)`);
	console.log('='.repeat(60));
}

main().catch(err => {
	console.error('❌ Error:', err);
	process.exit(1);
});
