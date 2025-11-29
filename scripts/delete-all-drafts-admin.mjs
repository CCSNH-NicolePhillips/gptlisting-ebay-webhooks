#!/usr/bin/env node
/**
 * Delete all eBay drafts using admin token (no auth needed)
 * 
 * Usage:
 *   node scripts/delete-all-drafts-admin.mjs
 * 
 * Requires prod.env to be loaded with ADMIN_API_TOKEN
 */

const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN;
const USER_SUB = process.env.USER_SUB || 'auth0|6756b51bde4eccdb8ae98de7'; // Your Auth0 user ID

if (!ADMIN_TOKEN) {
	console.error('❌ Missing ADMIN_API_TOKEN environment variable');
	console.error('Load it with: Get-Content prod.env | ForEach-Object { ... }');
	process.exit(1);
}

const BASE_URL = process.env.APP_URL || 'https://draftpilot.app';

async function deleteAllDrafts() {
	console.log('🗑️  Starting deletion of all drafts...\n');
	
	let totalDeleted = 0;
	let attempts = 0;
	const maxAttempts = 20; // More than web UI to ensure completion
	
	while (attempts < maxAttempts) {
		attempts++;
		const url = `${BASE_URL}/.netlify/functions/ebay-clean-drafts?deleteAll=true&deleteInventory=true&adminToken=${ADMIN_TOKEN}&userSub=${USER_SUB}`;
		
		console.log(`[Batch ${attempts}] Calling cleanup function...`);
		
		try {
			const res = await fetch(url);
			
			// Handle timeout
			if (res.status === 502) {
				console.log('   ⏱️  Function timeout (502) - continuing...');
				await new Promise(resolve => setTimeout(resolve, 2000));
				continue;
			}
			
			if (!res.ok) {
				const text = await res.text();
				console.error(`   ❌ Error ${res.status}:`, text);
				break;
			}
			
			const json = await res.json();
			const deleted = json.deletedOffers?.length || 0;
			totalDeleted += deleted;
			
			console.log(`   ✅ Deleted ${deleted} offers (total: ${totalDeleted})`);
			console.log(`   📊 Scanned ${json.scanned || 0} items, timedOut=${json.timedOut}`);
			
			// Check if done
			if (!json.timedOut && (!json.summary?.hasMore || json.scanned === 0)) {
				console.log('\n✅ All drafts deleted!');
				break;
			}
			
			// Wait before next batch
			await new Promise(resolve => setTimeout(resolve, 1000));
			
		} catch (err) {
			console.error('   ❌ Request failed:', err.message);
			await new Promise(resolve => setTimeout(resolve, 2000));
		}
	}
	
	console.log('\n' + '='.repeat(60));
	console.log(`✅ Deletion complete!`);
	console.log(`   Total batches: ${attempts}`);
	console.log(`   Total deleted: ${totalDeleted}`);
	console.log('='.repeat(60));
}

deleteAllDrafts().catch(err => {
	console.error('❌ Fatal error:', err);
	process.exit(1);
});
