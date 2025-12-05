#!/usr/bin/env node

/**
 * Get eBay Marketing campaigns to find the campaign ID for promotions
 * Run: node scripts/get-promo-campaign-id.mjs
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load prod.env
config({ path: join(__dirname, '..', 'prod.env') });

const EBAY_USER_TOKEN = process.env.EBAY_USER_TOKEN;
const EBAY_ENV = process.env.EBAY_ENV || 'production';

if (!EBAY_USER_TOKEN) {
  console.error('Error: EBAY_USER_TOKEN not found in prod.env');
  process.exit(1);
}

const apiHost = EBAY_ENV === 'sandbox'
  ? 'https://api.sandbox.ebay.com'
  : 'https://api.ebay.com';

const marketplaceId = 'EBAY_US';

async function getCampaigns() {
  const url = `${apiHost}/sell/marketing/v1/ad_campaign?campaign_status=RUNNING&limit=50`;
  
  console.log('Fetching eBay Promoted Listings campaigns...\n');
  
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${EBAY_USER_TOKEN}`,
      'Content-Type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`eBay API Error (${response.status}):`, errorText);
    process.exit(1);
  }

  const data = await response.json();
  
  if (!data.campaigns || data.campaigns.length === 0) {
    console.log('No RUNNING campaigns found.');
    console.log('\nYou need to create a Promoted Listings campaign in eBay Seller Hub first:');
    console.log('1. Go to: https://www.ebay.com/sh/mkt/campaigns');
    console.log('2. Click "Create campaign"');
    console.log('3. Set up a Standard campaign');
    console.log('4. Once created, run this script again to get the campaign ID');
    return;
  }

  console.log(`Found ${data.campaigns.length} campaign(s):\n`);
  
  data.campaigns.forEach((campaign, index) => {
    console.log(`Campaign ${index + 1}:`);
    console.log(`  ID: ${campaign.campaignId}`);
    console.log(`  Name: ${campaign.campaignName}`);
    console.log(`  Status: ${campaign.campaignStatus}`);
    console.log(`  Funding Strategy: ${campaign.fundingStrategy?.fundingModel || 'N/A'}`);
    console.log('');
  });

  const defaultCampaign = data.campaigns[0];
  console.log('━'.repeat(60));
  console.log('\n✓ Add this to your Netlify Environment Variables:');
  console.log(`\nEBAY_DEFAULT_PROMO_CAMPAIGN_ID=${defaultCampaign.campaignId}`);
  console.log('\n━'.repeat(60));
}

getCampaigns().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
