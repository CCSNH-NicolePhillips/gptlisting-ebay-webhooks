import 'dotenv/config';

const BASE = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function clearCache() {
  // Search for cache keys to clear
  const keysToFind = [
    'betteralt',
    'jarrow',
    'bettr',
  ];
  
  // Get all keys matching pricecache:*
  const scanRes = await fetch(BASE + '/keys/pricecache:*', {
    headers: { Authorization: 'Bearer ' + TOKEN }
  });
  const scanData = await scanRes.json();
  console.log('Found cache keys:', scanData.result);
  
  // Filter keys containing our search terms
  const keysToDelete = (scanData.result as string[])?.filter((key: string) => 
    keysToFind.some(term => key.toLowerCase().includes(term))
  ) || [];
  
  console.log('Keys to delete:', keysToDelete);
  
  // Delete each key
  for (const key of keysToDelete) {
    const delRes = await fetch(BASE + '/del/' + encodeURIComponent(key), {
      headers: { Authorization: 'Bearer ' + TOKEN }
    });
    const delData = await delRes.json();
    console.log('Deleted', key, ':', delData.result);
  }
  
  console.log('\nCleared', keysToDelete.length, 'cache entries');
}

clearCache().catch(console.error);
