#!/usr/bin/env node
/**
 * Cleanup script to delete ALL inventory items and offers from eBay Sandbox
 * This will clear out any corrupted SKUs causing the 25707 error
 */

const BASE_URL = 'http://localhost:8888';
const AUTH_TOKEN = process.env.LOCAL_AUTH_TOKEN || '';

if (!AUTH_TOKEN) {
  console.error('❌ Error: LOCAL_AUTH_TOKEN environment variable is required');
  process.exit(1);
}

async function authFetch(url, options = {}) {
  const headers = {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    ...options.headers,
  };
  
  const response = await fetch(url, { ...options, headers });
  return response;
}

async function deleteAllOffers() {
  console.log('\n🗑️  Step 1: Deleting all offers...');
  
  const response = await authFetch(`${BASE_URL}/.netlify/functions/ebay-delete-all-drafts`, {
    method: 'POST',
  });
  
  if (!response.ok) {
    const text = await response.text();
    console.warn(`Warning: ${response.status} ${text}`);
  } else {
    const result = await response.json();
    console.log('✅ Offers deleted:', result);
  }
}

async function deleteAllInventory() {
  console.log('\n🗑️  Step 2: Deleting all inventory items...');
  
  let deleted = 0;
  let errors = 0;
  
  // Get all inventory items
  const listResponse = await authFetch(`${BASE_URL}/.netlify/functions/ebay-list-inventory?limit=200`);
  
  if (!listResponse.ok) {
    throw new Error(`Failed to list inventory: ${listResponse.status}`);
  }
  
  const listData = await listResponse.json();
  const items = listData.inventoryItems || [];
  
  console.log(`Found ${items.length} inventory items`);
  
  for (const item of items) {
    const sku = item.sku;
    console.log(`Deleting SKU: ${sku}`);
    
    try {
      const deleteResponse = await authFetch(
        `${BASE_URL}/.netlify/functions/ebay-delete-inventory-item?sku=${encodeURIComponent(sku)}`,
        { method: 'DELETE' }
      );
      
      if (deleteResponse.ok || deleteResponse.status === 204 || deleteResponse.status === 404) {
        deleted++;
        console.log(`  ✅ Deleted: ${sku}`);
      } else {
        errors++;
        const text = await deleteResponse.text();
        console.error(`  ❌ Error deleting ${sku}: ${deleteResponse.status} ${text}`);
      }
    } catch (err) {
      errors++;
      console.error(`  ❌ Exception deleting ${sku}:`, err.message);
    }
    
    // Small delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log(`\n✅ Cleanup complete: ${deleted} deleted, ${errors} errors`);
}

async function main() {
  console.log('🧹 Starting eBay Sandbox cleanup...');
  console.log(`🌐 Using local server: ${BASE_URL}`);
  
  try {
    await deleteAllOffers();
    await deleteAllInventory();
    
    console.log('\n✅ All cleanup complete! Your eBay Sandbox inventory is now empty.');
    
  } catch (error) {
    console.error('\n❌ Cleanup failed:', error.message);
    process.exit(1);
  }
}

main();
