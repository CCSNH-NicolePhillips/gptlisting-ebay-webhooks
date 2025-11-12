import 'dotenv/config';

export const cfg = {
  port: Number(process.env.PORT || 3000),
  appUrl: process.env.APP_URL || 'http://localhost:3000',

  dataDir: process.env.DATA_DIR || '.tmp',

  dropbox: {
    clientId: process.env.DROPBOX_CLIENT_ID || '',
    clientSecret: process.env.DROPBOX_CLIENT_SECRET || '',
    redirectUri: process.env.DROPBOX_REDIRECT_URI || '',
  },

  ebay: {
    env: (process.env.EBAY_ENV || 'PROD').toUpperCase() as 'PROD' | 'SANDBOX',
    clientId: process.env.EBAY_CLIENT_ID || '',
    clientSecret: process.env.EBAY_CLIENT_SECRET || '',
    ruName: process.env.EBAY_RU_NAME || '',
    merchantLocationKey: process.env.EBAY_MERCHANT_LOCATION_KEY || '',
    policy: {
      paymentPolicyId: process.env.EBAY_PAYMENT_POLICY_ID || '',
      returnPolicyId: process.env.EBAY_RETURN_POLICY_ID || '',
      fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID || '',
    },
    defaultMarketplaceId: process.env.DEFAULT_MARKETPLACE_ID || 'EBAY_US',
    defaultCategoryId: process.env.DEFAULT_CATEGORY_ID || '99', // Everything Else
    promotedCampaignId: process.env.PROMOTED_CAMPAIGN_ID || '',
  },

  defaults: {
    publishMode: (process.env.PUBLISH_MODE || 'draft') as 'draft' | 'post' | 'legacy-post',
  },
};

export const USE_ROLE_SORTING = (process.env.USE_ROLE_SORTING ?? 'true') === 'true';
export const USE_NEW_SORTER = (process.env.USE_NEW_SORTER ?? 'true') === 'true';
export const STRICT_TWO_ONLY = (process.env.STRICT_TWO_ONLY ?? 'true') === 'true';

// Phase S1: Hard-disable CLIP embeddings (moving to vision-only + pairing system)
export const USE_CLIP = (process.env.USE_CLIP ?? 'false') === 'true';
