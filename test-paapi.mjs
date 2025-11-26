import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const config = {
  accessKeyId: process.env.AMAZON_PAAPI_ACCESS_KEY_ID,
  secretAccessKey: process.env.AMAZON_PAAPI_SECRET_KEY,
  partnerTag: process.env.AMAZON_PAAPI_PARTNER_TAG,
  region: process.env.AMAZON_PAAPI_REGION || 'us-east-1'
};

console.log('Testing Amazon PA-API credentials...');
console.log('Access Key:', config.accessKeyId?.substring(0, 10) + '...');
console.log('Partner Tag:', config.partnerTag);
console.log('Region:', config.region);
console.log('');

// Sign AWS request
function signAwsRequest(accessKeyId, secretAccessKey, region, service, host, path, body) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');

  const canonicalHeaders =
    `content-encoding:amz-1.0\n` +
    `content-type:application/json; charset=utf-8\n` +
    `host:${host}\n` +
    `x-amz-date:${amzDate}\n`;

  const signedHeaders = 'content-encoding;content-type;host;x-amz-date';

  const canonicalRequest = [
    'POST',
    path,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')
  ].join('\n');

  const kDate = crypto.createHmac('sha256', 'AWS4' + secretAccessKey).update(dateStamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();

  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorizationHeader =
    `${algorithm} Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `https://${host}${path}`,
    headers: {
      'Content-Encoding': 'amz-1.0',
      'Content-Type': 'application/json; charset=utf-8',
      'Host': host,
      'X-Amz-Date': amzDate,
      'Authorization': authorizationHeader,
    },
    body
  };
}

// Test request - minimal valid request per PA-API v5 docs
const bodyObj = {
  Keywords: 'collagen protein powder',
  Resources: [
    'ItemInfo.Title',
    'Offers.Listings.Price'
  ],
  PartnerTag: config.partnerTag,
  PartnerType: 'Associates'
};

const bodyJson = JSON.stringify(bodyObj);

// Try the correct US marketplace endpoint
const signed = signAwsRequest(
  config.accessKeyId,
  config.secretAccessKey,
  config.region,
  'ProductAdvertisingAPIv2',
  'webservices.amazon.com',
  '/paapi5/searchitems',
  bodyJson
);

console.log('Making request to:', signed.url);
console.log('Service: ProductAdvertisingAPI, Region:', config.region);
console.log('Request body:', bodyJson);
console.log('');

try {
  const resp = await fetch(signed.url, {
    method: 'POST',
    headers: signed.headers,
    body: signed.body
  });

  const text = await resp.text();
  
  console.log('Response Status:', resp.status, resp.statusText);
  console.log('Response Length:', text.length, 'bytes');
  console.log('');
  
  if (resp.ok) {
    const json = JSON.parse(text);
    const items = json?.SearchResult?.Items || [];
    console.log('✅ SUCCESS! Found', items.length, 'items');
    if (items[0]) {
      const item = items[0];
      const price = item.Offers?.Listings?.[0]?.Price?.Amount;
      console.log('First item:', item.ItemInfo?.Title?.DisplayValue);
      console.log('Price:', price ? `$${price}` : 'N/A');
    }
  } else {
    console.log('❌ ERROR Response:');
    console.log(text);
  }
} catch (err) {
  console.error('❌ Request failed:', err.message);
}
