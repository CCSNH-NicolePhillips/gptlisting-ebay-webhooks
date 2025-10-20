import { argv } from 'process';
import { request } from 'undici';

async function main() {
  const mode = process.env.PUBLISH_MODE || 'draft';
  const limit = Number(process.env.LIMIT || 10);
  const body = {
    mode,
    folderPath: '/EBAY',
    quantityDefault: 1,
    marketplaceId: 'EBAY_US',
    categoryId: '177011',
  };
  const url = `http://localhost:3000/process?limit=${limit}`;
  const r = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.body.json();
  console.log(JSON.stringify(j, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
