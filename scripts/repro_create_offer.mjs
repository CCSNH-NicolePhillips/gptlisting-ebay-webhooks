import fs from 'fs';
import path from 'path';
import 'dotenv/config';

async function getAccessToken() {
  const dataDir = process.env.DATA_DIR || '.tmp';
  const tokensPath = path.join(dataDir, 'ebay_tokens.json');
  const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
  const refresh = tokens.demo?.refresh_token;
  if (!refresh) {
    console.error('No demo refresh token');
    process.exit(2);
  }
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh });
  const clientId = process.env.EBAY_CLIENT_ID || '';
  const clientSecret = process.env.EBAY_CLIENT_SECRET || '';
  const auth = 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const base =
    (process.env.EBAY_ENV || 'SANDBOX').toUpperCase() === 'PROD'
      ? 'https://api.ebay.com'
      : 'https://api.sandbox.ebay.com';
  const tokRes = await fetch(base + '/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: auth },
    body: form.toString(),
  });
  const tokJson = await tokRes.json();
  if (!tokJson?.access_token) {
    console.error('token fetch failed', tokRes.status, tokJson);
    process.exit(3);
  }
  return { access: tokJson.access_token, base };
}

async function call(path, method = 'GET', body) {
  const { access, base } = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${access}`,
    'Content-Type': 'application/json',
    'Accept-Language': 'en-US',
    'Content-Language': 'en-US',
  };
  const r = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text().catch(() => null);
  let j = null;
  try {
    j = JSON.parse(text);
  } catch (e) {}
  console.log('CALL', method, path, 'STATUS', r.status);
  console.log(text || '<no body>');
  return { status: r.status, body: j ?? text };
}

(async () => {
  // ensure inventory item
  const sku = 'REPRO-TEST-SKU-001';
  const itemPayload = {
    condition: 'NEW',
    availability: { shipToLocationAvailability: { quantity: 1 } },
    product: { title: 'Test', description: 'test', imageUrls: ['https://via.placeholder.com/600'] },
  };
  await call(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, 'PUT', itemPayload);

  // list account policies and pick IDs
  const payment = await call('/sell/account/v1/payment_policy?marketplace_id=EBAY_US', 'GET');
  const returnP = await call('/sell/account/v1/return_policy?marketplace_id=EBAY_US', 'GET');
  const fulfillment = await call(
    '/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US',
    'GET'
  );

  const paymentId =
    (payment.body?.paymentPolicies && payment.body.paymentPolicies[0]?.paymentPolicyId) ||
    process.env.EBAY_PAYMENT_POLICY_ID;
  const returnId =
    (returnP.body?.returnPolicies && returnP.body.returnPolicies[0]?.returnPolicyId) ||
    process.env.EBAY_RETURN_POLICY_ID;
  const fulfillmentId =
    (fulfillment.body?.fulfillmentPolicies &&
      fulfillment.body.fulfillmentPolicies[0]?.fulfillmentPolicyId) ||
    process.env.EBAY_FULFILLMENT_POLICY_ID;

  console.log('Using policy ids:', { paymentId, returnId, fulfillmentId });

  const merchantLocationKey = process.env.EBAY_MERCHANT_LOCATION_KEY || 'AutoWarehouse01';

  const offerPayload = {
    sku,
    marketplaceId: 'EBAY_US',
    format: 'FIXED_PRICE',
    availableQuantity: 1,
    categoryId: process.env.DEFAULT_CATEGORY_ID || '177011',
    listingPolicies: {
      fulfillmentPolicyId: fulfillmentId,
      paymentPolicyId: paymentId,
      returnPolicyId: returnId,
    },
    pricingSummary: { price: { currency: 'USD', value: '9.99' } },
    merchantLocationKey,
  };

  await call('/sell/inventory/v1/offer', 'POST', offerPayload);
})();
