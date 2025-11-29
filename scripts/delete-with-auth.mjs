#!/usr/bin/env node
/**
 * Delete all eBay drafts using browser auth token
 * 
 * Usage:
 *   node scripts/delete-with-auth.mjs "YOUR_BEARER_TOKEN"
 */

const AUTH_TOKEN = process.argv[2];

if (!AUTH_TOKEN) {
	console.error('❌ Missing auth token');
	console.error('Usage: node scripts/delete-with-auth.mjs "Bearer eyJ..."');
	process.exit(1);
}

const BASE_URL = 'https://draftpilot.app';

async function deleteAllDrafts() {
	console.log('🗑️  Starting deletion of all drafts...\n');
	
	let totalDeleted = 0;
	let attempts = 0;
	const maxAttempts = 20;
	
	while (attempts < maxAttempts) {
		attempts++;
		const url = `${BASE_URL}/.netlify/functions/ebay-clean-broken-drafts?deleteAll=true&deleteInventory=true&skipFastScan=true`;
		
		console.log(`[Batch ${attempts}] Calling cleanup function...`);
		
		try {
			const res = await fetch(url, {
				headers: {
					'Authorization': AUTH_TOKEN.startsWith('Bearer ') ? AUTH_TOKEN : `Bearer ${AUTH_TOKEN}`,
				}
			});
			
			// Handle timeout
			if (res.status === 502) {
				console.log('   ⏱️  Function timeout (502) - continuing...');
				await new Promise(resolve => setTimeout(resolve, 2000));
				continue;
			}
			
			if (!res.ok) {
				const text = await res.text();
				console.error(`   ❌ Error ${res.status}:`, text);
				
				if (res.status === 401) {
					console.error('\n💡 Token expired. Get a new one from browser DevTools.');
					break;
				}
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
