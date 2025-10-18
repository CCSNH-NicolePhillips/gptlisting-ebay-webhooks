import fs from 'fs';
import path from 'path';
import 'dotenv/config';

async function main(){
  // Load tokens from the same data dir used by the app (default .tmp or from env)
  const dataDir = process.env.DATA_DIR || '.tmp';
  const tokensPath = path.join(dataDir, 'ebay_tokens.json');
  const tokens = JSON.parse(fs.readFileSync(tokensPath,'utf8'));
  const refresh = tokens.demo?.refresh_token;
  if(!refresh){ console.error('No demo refresh token found in', tokensPath); process.exit(2); }

  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh });
  const clientId = process.env.EBAY_CLIENT_ID || '';
  const clientSecret = process.env.EBAY_CLIENT_SECRET || '';
  if(!clientId || !clientSecret){ console.error('Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET in environment'); process.exit(3); }
  const auth = 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const base = (process.env.EBAY_ENV || 'SANDBOX').toUpperCase() === 'PROD' ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';

  const tokRes = await fetch(base + '/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': auth },
    body: form.toString()
  });
  const tokJson = await tokRes.json().catch(()=>null);
  console.log('TOKEN_STATUS', tokRes.status);
  console.log(JSON.stringify(tokJson, null, 2));
  if(!tokJson?.access_token){ console.error('Failed to obtain access token'); process.exit(3); }
  const access = tokJson.access_token;

  const sku = 'REPRO-TEST-SKU-001';
  const payload = {
    condition: 'NEW',
    availability: { shipToLocationAvailability: { quantity: 1 } },
    product: { title: 'Test repro', description: 'test', imageUrls: ['https://via.placeholder.com/600'] }
  };

  const r = await fetch(`${base}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${access}`, 'Content-Type': 'application/json', 'Accept-Language': 'en-US', 'Content-Language': 'en-US' },
    body: JSON.stringify(payload)
  });
  const text = await r.text().catch(()=>null);
  console.log('PUT_STATUS', r.status);
  console.log(text);
}

main().catch(err=>{ console.error('ERR',err); process.exit(1); });
