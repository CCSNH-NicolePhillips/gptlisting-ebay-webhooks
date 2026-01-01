#!/usr/bin/env tsx
/**
 * Debug Amazon search via SearchAPI.io
 */

async function testAmazonSearch() {
  const apiKey = process.env.SEARCHAPI_KEY || 'dKs6WJSoCusJmMiJdenTrSLf';
  const keywords = 'Cymbiotika Liposomal Magnesium L-Threonate';

  console.log('Testing Amazon Search API...\n');
  console.log(`Search query: "${keywords}"\n`);

  // Try different parameter combinations
  const tests = [
    { name: 'amazon_search with q', params: { engine: 'amazon_search', amazon_domain: 'amazon.com', q: keywords } },
    { name: 'amazon_search with search_term', params: { engine: 'amazon_search', amazon_domain: 'amazon.com', search_term: keywords } },
    { name: 'amazon with q', params: { engine: 'amazon', q: keywords } },
    { name: 'just amazon_search', params: { engine: 'amazon_search', q: keywords } },
  ];

  for (const test of tests) {
    console.log(`\n🧪 Test: ${test.name}`);
    console.log('─'.repeat(60));
    
    const params = new URLSearchParams(test.params as any);
    const url = `https://www.searchapi.io/api/v1/search?${params.toString()}`;
    
    console.log(`URL: ${url.substring(0, 100)}...`);
    
    try {
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      console.log(`Status: ${response.status}`);
      
      const data: any = await response.json();
      
      if (!response.ok) {
        console.log(`❌ Error: ${data.error || JSON.stringify(data)}`);
        continue;
      }

      console.log(`✅ Success!`);
      console.log(`Keys in response: ${Object.keys(data).join(', ')}`);
      
      if (data.organic_results) {
        console.log(`organic_results count: ${data.organic_results.length}`);
        if (data.organic_results.length > 0) {
          const first = data.organic_results[0];
          console.log(`First result:`);
          console.log(`  Title: ${first.title || first.name}`);
          console.log(`  Price: ${JSON.stringify(first.price)}`);
        }
      }
      
      if (data.search_results) {
        console.log(`search_results count: ${data.search_results.length}`);
        if (data.search_results.length > 0) {
          const first = data.search_results[0];
          console.log(`First result:`);
          console.log(`  Title: ${first.title || first.name}`);
          console.log(`  Price: ${JSON.stringify(first.price)}`);
        }
      }

      // Print all top-level keys with counts
      for (const key of Object.keys(data)) {
        if (Array.isArray(data[key])) {
          console.log(`  ${key}: [${data[key].length} items]`);
        }
      }
      
    } catch (error: any) {
      console.log(`❌ Exception: ${error.message}`);
    }
  }
}

testAmazonSearch().catch(console.error);
