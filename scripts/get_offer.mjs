import fs from 'fs';
import path from 'path';
import 'dotenv/config';

async function main(offerId) {
  const dataDir = process.env.DATA_DIR || '.tmp';
  const tokensPath = path.join(dataDir, 'ebay_tokens.json');
  if (!fs.existsSync(tokensPath)) {
    console.error('Tokens file not found at', tokensPath);
    process.exit(2);
  }
  const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
  const refresh = tokens.demo?.refresh_token;
  if (!refresh) {
    console.error('No demo refresh token found');
    process.exit(3);
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('Missing EBAY_CLIENT_ID/SECRET in env');
    process.exit(4);
  }

  const base =
    (process.env.EBAY_ENV || 'SANDBOX').toUpperCase() === 'PROD'
      ? 'https://api.ebay.com'
      : 'https://api.sandbox.ebay.com';
  const auth = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh });

  const tokRes = await fetch(`${base}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: auth },
    body: form.toString(),
  });
  const tokJson = await tokRes.json().catch(() => null);
  if (!tokJson?.access_token) {
    console.error('Failed to get access token', JSON.stringify(tokJson));
    process.exit(5);
  }
  const access = tokJson.access_token;

  const r = await fetch(`${base}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US',
      'Content-Language': 'en-US',
    },
  });
  const text = await r.text().catch(() => null);
  console.log('STATUS', r.status);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

const offerId = process.argv[2];
if (!offerId) {
  console.error('Usage: node scripts/get_offer.mjs <offerId>');
  process.exit(1);
}
main(offerId).catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
