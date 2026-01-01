#!/usr/bin/env tsx
/**
 * Debug script to see the actual eBay Finding API error response
 */
import "dotenv/config";

async function testFindingAPI() {
  const appId = process.env.EBAY_APP_ID || process.env.EBAY_CLIENT_ID;
  
  console.log(`Using App ID: ${appId?.slice(0, 20)}...`);
  console.log(`EBAY_ENV: ${process.env.EBAY_ENV || 'PROD'}`);
  
  const baseUrl = process.env.EBAY_ENV === 'sandbox' 
    ? 'https://svcs.sandbox.ebay.com/services/search/FindingService/v1'
    : 'https://svcs.ebay.com/services/search/FindingService/v1';

  const searchUrl = new URL(baseUrl);
  searchUrl.searchParams.set('OPERATION-NAME', 'findCompletedItems');
  searchUrl.searchParams.set('SERVICE-VERSION', '1.0.0');
  searchUrl.searchParams.set('SECURITY-APPNAME', appId!);
  searchUrl.searchParams.set('RESPONSE-DATA-FORMAT', 'JSON');
  searchUrl.searchParams.set('REST-PAYLOAD', '');
  searchUrl.searchParams.set('keywords', 'iPhone');
  searchUrl.searchParams.set('paginationInput.entriesPerPage', '10');
  
  // Add filters
  searchUrl.searchParams.set('itemFilter(0).name', 'SoldItemsOnly');
  searchUrl.searchParams.set('itemFilter(0).value', 'true');

  console.log(`\nFull URL: ${searchUrl.toString()}\n`);

  try {
    const response = await fetch(searchUrl.toString(), {
      headers: { 'Accept': 'application/json' },
    });

    console.log(`Status: ${response.status} ${response.statusText}`);
    console.log(`Headers:`, Object.fromEntries(response.headers.entries()));
    
    const text = await response.text();
    console.log(`\nRaw response (first 2000 chars):\n${text.slice(0, 2000)}`);
    
    try {
      const json = JSON.parse(text);
      console.log(`\nParsed JSON:\n${JSON.stringify(json, null, 2).slice(0, 2000)}`);
      
      // Check for error in response
      const errorMessage = json?.findCompletedItemsResponse?.[0]?.errorMessage;
      if (errorMessage) {
        console.log(`\n❌ Error in response:`, errorMessage);
      }
    } catch (e) {
      console.log(`\n⚠️ Could not parse as JSON`);
    }
  } catch (error) {
    console.error(`❌ Fetch error:`, error);
  }
}

testFindingAPI();
