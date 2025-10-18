import fs from 'fs';
import path from 'path';
import 'dotenv/config';

async function getAccess(){
  const dataDir = process.env.DATA_DIR || '.tmp';
  const tokensPath = path.join(dataDir, 'ebay_tokens.json');
  const tokens = JSON.parse(fs.readFileSync(tokensPath,'utf8'));
  const refresh = tokens.demo?.refresh_token;
  if(!refresh) throw new Error('no refresh token');
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const base = (process.env.EBAY_ENV || 'SANDBOX').toUpperCase() === 'PROD' ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';
  const auth = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh });
  const tokRes = await fetch(`${base}/identity/v1/oauth2/token`, { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded', Authorization: auth }, body: form.toString() });
  const tok = await tokRes.json();
  if(!tok?.access_token) throw new Error('token failed '+JSON.stringify(tok));
  return { access: tok.access_token, base };
}

async function main(){
  const sku = process.argv[2] || 'two';
  const offerId = process.argv[3] || '9555441010';
  const price = process.argv[4] || '19.99';
  const quantity = Number(process.argv[5] || 5);
  const categoryId = process.argv[6] || '26395';
  const title = process.argv[7] || 'Vitamin Supplement - Sample';
  const description = process.argv[8] || 'Auto-listed supplement from Dropbox photos.';

  const { access, base } = await getAccess();

  console.log('Fetching inventory', sku);
  const getInv = await fetch(`${base}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { method:'GET', headers:{ Authorization:`Bearer ${access}`, 'Accept-Language':'en-US','Content-Language':'en-US' } });
  const invText = await getInv.text();
  if(getInv.status !== 200) { console.error('Failed to get inventory', getInv.status, invText); process.exit(2); }
  const inv = JSON.parse(invText);
  const imageUrls = inv.product?.imageUrls ?? [];

  const payload = {
    condition: inv.condition || 'NEW',
    availability: { shipToLocationAvailability: { quantity } },
    product: { title, description, imageUrls }
  };

  console.log('Updating inventory (PUT)...');
  const putInv = await fetch(`${base}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { method:'PUT', headers:{ Authorization:`Bearer ${access}`, 'Content-Type':'application/json','Accept-Language':'en-US','Content-Language':'en-US' }, body: JSON.stringify(payload) });
  console.log('PUT inventory status', putInv.status);
  if(!putInv.ok){ console.error(await putInv.text()); process.exit(3); }

  console.log('Fetching offer', offerId);
  const getOffer = await fetch(`${base}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { method:'GET', headers:{ Authorization:`Bearer ${access}`, 'Accept-Language':'en-US','Content-Language':'en-US' } });
  const offerText = await getOffer.text();
  if(getOffer.status !== 200){ console.error('Failed to get offer', getOffer.status, offerText); process.exit(4); }
  const offer = JSON.parse(offerText);

  offer.pricingSummary = { price: { currency: 'USD', value: String(price) } };
  offer.availableQuantity = quantity;
  offer.categoryId = String(categoryId);

  console.log('Updating offer (PUT)...');
  const putOffer = await fetch(`${base}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { method:'PUT', headers:{ Authorization:`Bearer ${access}`, 'Content-Type':'application/json','Accept-Language':'en-US','Content-Language':'en-US' }, body: JSON.stringify(offer) });
  console.log('PUT offer status', putOffer.status);
  const putOfferText = await putOffer.text();
  if(!putOffer.ok){ console.error(putOfferText); process.exit(5); }

  console.log('Fetching updated offer');
  const final = await fetch(`${base}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { method:'GET', headers:{ Authorization:`Bearer ${access}`, 'Accept-Language':'en-US','Content-Language':'en-US' } });
  const finalText = await final.text();
  console.log('FINAL STATUS', final.status);
  console.log(finalText);
}

main().catch(e=>{ console.error('ERR', e); process.exit(1); });
