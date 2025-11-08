import 'dotenv/config';

const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

async function checkRateLimit() {
  try {
    // Get OAuth token
    const authString = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
    
    const tokenResponse = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${authString}`,
      },
      body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
    });

    if (!tokenResponse.ok) {
      throw new Error(`Failed to get OAuth token: ${tokenResponse.status}`);
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // Make a simple API call to check rate limit headers
    const testResponse = await fetch(
      'https://api.ebay.com/commerce/taxonomy/v1/category_tree/0',
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        },
      }
    );

    console.log('\n📊 eBay API Rate Limit Status:\n');
    
    // Check rate limit headers
    const headers = testResponse.headers;
    
    // Common eBay rate limit headers
    const rateLimitHeaders = [
      'x-ebay-api-call-limit-remaining',
      'x-ebay-api-call-limit',
      'x-rate-limit-limit',
      'x-rate-limit-remaining',
      'x-rate-limit-reset',
    ];

    let foundHeaders = false;
    for (const headerName of rateLimitHeaders) {
      const value = headers.get(headerName);
      if (value) {
        console.log(`  ${headerName}: ${value}`);
        foundHeaders = true;
      }
    }

    if (!foundHeaders) {
      console.log('  ⚠️  No rate limit headers found in response');
      console.log('\n  Available headers:');
      for (const [key, value] of headers.entries()) {
        console.log(`    ${key}: ${value}`);
      }
    }

    console.log(`\n  Response Status: ${testResponse.status} ${testResponse.statusText}`);
    
    if (testResponse.status === 429) {
      console.log('\n  ⚠️  YOU ARE CURRENTLY RATE LIMITED!');
      const retryAfter = headers.get('retry-after');
      if (retryAfter) {
        console.log(`  Wait ${retryAfter} seconds before making more requests`);
      }
    }

    // eBay typically has these limits (as of 2024):
    console.log('\n📋 Typical eBay API Limits:');
    console.log('  • Application-level: 5,000 calls per day');
    console.log('  • User-level: Varies by API (usually 5,000 per day)');
    console.log('  • Some APIs: 10 calls per second burst');
    console.log('\n💡 Tip: Rate limits reset at midnight Pacific Time');

  } catch (error) {
    console.error('❌ Error checking rate limit:', error.message);
  }
}

checkRateLimit();
