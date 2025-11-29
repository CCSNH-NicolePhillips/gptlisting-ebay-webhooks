#!/usr/bin/env node
/**
 * Delete all eBay inventory items using bearer token from browser
 * Calls the Netlify function repeatedly until everything is deleted
 * 
 * Usage:
 *   node scripts/delete-with-bearer-token.mjs
 */

const BEARER_TOKEN = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IkZldjZibTR1clpsczRmcmNoVlY4diJ9.eyJpc3MiOiJodHRwczovL2Rldi1mNnl1MnIxNmI1NnI3b3g2LnVzLmF1dGgwLmNvbS8iLCJzdWIiOiJnb29nbGUtb2F1dGgyfDEwODc2NzU5OTk5ODQ5NDUzMTQwMyIsImF1ZCI6WyJodHRwczovL2RyYWZ0cGlsb3QtYWkubmV0bGlmeS5hcHAvYXBpIiwiaHR0cHM6Ly9kZXYtZjZ5dTJyMTZiNTZyN294Ni51cy5hdXRoMC5jb20vdXNlcmluZm8iXSwiaWF0IjoxNzY0MzcyNTA2LCJleHAiOjE3NjQ0NTg5MDYsInNjb3BlIjoib3BlbmlkIHByb2ZpbGUgZW1haWwiLCJhenAiOiJUejdDa1d5ckkwd0xQckVvcVBxRU5rS1BCNUJvN21iRSJ9.qNkDG8fdtXotWuGQR9NvCOGMMtkufwlL4aKYOKWf8_f8C5faXcgENTRgqKjdTEkvv9qM9f1hoKbYDOJq6zoFWj3XBjRA48gDMe4_PTP0IrTMkK-8i-yJd8P65RUbhQhmFe4vEWcE1ohapKJDEvX8lPi_IceBM0_MAV4h-FWNmNa-9BxziVa2IK5RrpeHaa1VsZQDAG4cQH5sve2S4hUSAPsfNXpzE9ZK89_300F6-YemZl9FurexbHEDTUCUVMSb8L7TEX-a42jPBofah8nV5KgvIqdEbBu5UuQUersTMx9TPdB1lKWRHR5HfpfLMNxsvXHviWPwlkRHkmjqqHFyCw';

const BASE_URL = 'https://draftpilot.app';

async function callCleanup() {
	// Call the function with nuclear=true to skip all offer checking and just delete inventory
	const url = `${BASE_URL}/.netlify/functions/ebay-clean-broken-drafts?deleteInventory=true&nuclear=true`;
	
	const res = await fetch(url, {
		headers: {
			'Authorization': `Bearer ${BEARER_TOKEN}`,
			'Accept': 'application/json'
		}
	});
	
	// Handle 502 timeout as success (it's still working)
	if (res.status === 502) {
		return { timedOut: true, deletedCount: 0 };
	}
	
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Request failed: ${res.status} ${text.substring(0, 200)}`);
	}
	
	return await res.json();
}

async function deleteAllInventory() {
	console.log('🗑️  Starting deletion of all eBay inventory items...\n');
	
	let totalDeleted = 0;
	let attempts = 0;
	const maxAttempts = 30;
	
	while (attempts < maxAttempts) {
		attempts++;
		console.log(`[Batch ${attempts}] Calling cleanup function...`);
		
		try {
			const result = await callCleanup();
			const deleted = result.deletedInventory?.length || result.deletedOffers?.length || 0;
			totalDeleted += deleted;
			
			console.log(`   ✅ Deleted ${deleted} items (total: ${totalDeleted})`);
			
			if (result.timedOut) {
				console.log(`   ⏱️  Function timed out (still processing)...`);
				await new Promise(resolve => setTimeout(resolve, 2000));
				continue;
			}
			
			// Check if done
			if (deleted === 0 && !result.timedOut) {
				console.log('\n✅ All items deleted!');
				break;
			}
			
			// Wait before next batch
			await new Promise(resolve => setTimeout(resolve, 1000));
			
		} catch (err) {
			console.error(`   ❌ Error: ${err.message}`);
			await new Promise(resolve => setTimeout(resolve, 2000));
		}
	}
	
	console.log('\n' + '='.repeat(60));
	console.log(`✅ Deletion complete!`);
	console.log(`   Total batches: ${attempts}`);
	console.log(`   Total deleted: ${totalDeleted}`);
	console.log('='.repeat(60));
}

deleteAllInventory().catch(err => {
	console.error('\n❌ Fatal error:', err.message);
	process.exit(1);
});
