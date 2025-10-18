import fs from 'fs';
import path from 'path';
import 'dotenv/config';

async function getAccessToken(){
  const dataDir = process.env.DATA_DIR || '.tmp';
  const tokensPath = path.join(dataDir, 'ebay_tokens.json');
  const tokens = JSON.parse(fs.readFileSync(tokensPath,'utf8'));
  const refresh = tokens.demo?.refresh_token;
  if(!refresh){ console.error('No demo refresh token'); process.exit(2); }
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh });
  const clientId = process.env.EBAY_CLIENT_ID || '';
  const clientSecret = process.env.EBAY_CLIENT_SECRET || '';
  const auth = 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const base = (process.env.EBAY_ENV || 'SANDBOX').toUpperCase() === 'PROD' ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';
  const tokRes = await fetch(base + '/identity/v1/oauth2/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','Authorization':auth}, body: form.toString()});
  const tokJson = await tokRes.json();
  if(!tokJson?.access_token){ console.error('token fetch failed', tokRes.status, tokJson); process.exit(3); }
  return { access: tokJson.access_token, base };
}

async function call(path, method='GET', body){
  const { access, base } = await getAccessToken();
  const headers = { 'Authorization': `Bearer ${access}`, 'Content-Type':'application/json', 'Accept-Language':'en-US', 'Content-Language':'en-US' };
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text().catch(()=>null);
  let j = null;
  try{ j = JSON.parse(text); }catch(e){}
  console.log('CALL', method, path, 'STATUS', r.status);
  console.log(text || '<no body>');
  return { status: r.status, body: j ?? text };
}

(async ()=>{
  // Payment policy create
  const paymentBody = {
    name: 'Auto Payment Policy',
    marketplaceId: 'EBAY_US',
    categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES', default: true }],
    immediatePay: true
  };
  await call('/sell/account/v1/payment_policy','POST',paymentBody);

  const returnBody = {
    name: 'Auto Return Policy',
    marketplaceId: 'EBAY_US',
    categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES', default: true }],
    returnsAccepted: true,
    returnPeriod: { value: 30, unit: 'DAY' },
    refundMethod: 'MONEY_BACK',
    returnShippingCostPayer: 'BUYER',
    internationalOverride: {
      returnsAccepted: true,
      returnMethod: 'MONEY_BACK',
      returnPeriod: { value: 30, unit: 'DAY' },
      returnShippingCostPayer: 'BUYER'
    }
  };
  await call('/sell/account/v1/return_policy','POST',returnBody);

  const fulfillmentBody = {
    name: 'Auto Shipping Policy',
    marketplaceId: 'EBAY_US',
    categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES', default: true }],
    handlingTime: { value: 2, unit: 'DAY' },
    shippingOptions: [{
      costType: 'FLAT_RATE',
      optionType: 'DOMESTIC',
      shippingServices: [{
        buyerResponsibleForShipping: false,
        freeShipping: true,
        shippingCarrierCode: 'USPS',
        shippingServiceCode: 'USPSPriority'
      }]
    }]
  };
  await call('/sell/account/v1/fulfillment_policy','POST',fulfillmentBody);

  // Inventory location create (similar to ensureInventoryLocation primary path)
  const locationBody = {
    name: 'Auto Warehouse',
    locationTypes: ['WAREHOUSE'],
    merchantLocationStatus: 'ENABLED',
    location: { address: { addressLine1: '123 Test St', addressLine2: '', city: 'San Jose', stateOrProvince: 'CA', postalCode: '95131', country: 'US' } },
    phone: '+15550100100',
    operatingHours: []
  };
  await call('/sell/inventory/v1/location/AutoWarehouse01','POST',locationBody);

})();
