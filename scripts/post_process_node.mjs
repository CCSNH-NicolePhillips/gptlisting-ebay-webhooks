import 'dotenv/config';

(async () => {
  try {
    const port = process.env.PORT || '3001';
    const url = `http://localhost:${port}/process?limit=1`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'draft', folderPath: '/EBAY' }),
    });
    const text = await r.text();
    console.log('STATUS', r.status);
    try {
      console.log(JSON.parse(text));
    } catch {
      console.log(text);
    }
  } catch (e) {
    console.error('ERR', e);
    process.exit(1);
  }
})();
