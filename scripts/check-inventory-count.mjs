#!/usr/bin/env node
/**
 * Check how many inventory items remain in eBay account
 */

const BEARER_TOKEN = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IkZldjZibTR1clpsczRmcmNoVlY4diJ9.eyJpc3MiOiJodHRwczovL2Rldi1mNnl1MnIxNmI1NnI3b3g2LnVzLmF1dGgwLmNvbS8iLCJzdWIiOiJnb29nbGUtb2F1dGgyfDEwODc2NzU5OTk5ODQ5NDUzMTQwMyIsImF1ZCI6WyJodHRwczovL2RyYWZ0cGlsb3QtYWkubmV0bGlmeS5hcHAvYXBpIiwiaHR0cHM6Ly9kZXYtZjZ5dTJyMTZiNTZyN294Ni51cy5hdXRoMC5jb20vdXNlcmluZm8iXSwiaWF0IjoxNzY0MzcyNTA2LCJleHAiOjE3NjQ0NTg5MDYsInNjb3BlIjoib3BlbmlkIHByb2ZpbGUgZW1haWwiLCJhenAiOiJUejdDa1d5ckkwd0xQckVvcVBxRU5rS1BCNUJvN21iRSJ9.qNkDG8fdtXotWuGQR9NvCOGMMtkufwlL4aKYOKWf8_f8C5faXcgENTRgqKjdTEkvv9qM9f1hoKbYDOJq6zoFWj3XBjRA48gDMe4_PTP0IrTMkK-8i-yJd8P65RUbhQhmFe4vEWcE1ohapKJDEvX8lPi_IceBM0_MAV4h-FWNmNa-9BxziVa2IK5RrpeHaa1VsZQDAG4cQH5sve2S4hUSAPsfNXpzE9ZK89_300F6-YemZl9FurexbHEDTUCUVMSb8L7TEX-a42jPBofah8nV5KgvIqdEbBu5UuQUersTMx9TPdB1lKWRHR5HfpfLMNxsvXHviWPwlkRHkmjqqHFyCw';

const BASE_URL = 'https://draftpilot.app';

async function checkInventory() {
	console.log('📋 Checking eBay offers and inventory...\n');
	
	const url = `${BASE_URL}/.netlify/functions/ebay-list-offers`;
	
	const res = await fetch(url, {
		headers: {
			'Authorization': `Bearer ${BEARER_TOKEN}`,
			'Accept': 'application/json'
		}
	});
	
	if (!res.ok) {
		const text = await res.text();
		console.log(`Status: ${res.status}`);
		console.log(`Response: ${text.substring(0, 500)}`);
		throw new Error(`Failed to list offers: ${res.status}`);
	}
	
	const data = await res.json();
	
	console.log('='.repeat(60));
	console.log(`Total offers: ${data.total || 0}`);
	console.log(`Offers in response: ${data.offers?.length || 0}`);
	console.log('='.repeat(60));
	
	if (data.offers && data.offers.length > 0) {
		console.log('\nFirst few offers:');
		data.offers.slice(0, 10).forEach((offer, i) => {
			console.log(`  ${i + 1}. ${offer.status}: ${offer.sku} - ${offer.offerId}`);
		});
	} else {
		console.log('\n✅ No offers found - completely clean!');
	}
	
	return data;
}

checkInventory().catch(err => {
	console.error('\n❌ Error:', err.message);
	process.exit(1);
});
