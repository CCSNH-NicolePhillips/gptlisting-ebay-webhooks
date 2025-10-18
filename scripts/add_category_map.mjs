import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const dataDir = process.env.DATA_DIR || '.tmp';
const mapPath = path.join(dataDir, 'category_map.json');
const args = process.argv.slice(2);
if (args.length % 2 !== 0 || args.length === 0) {
  console.error('Usage: node add_category_map.mjs <SKU> <CategoryId> [<SKU> <CategoryId> ...]');
  process.exit(2);
}
let map = {};
if (fs.existsSync(mapPath)) map = JSON.parse(fs.readFileSync(mapPath,'utf8')||'{}');
for (let i=0;i<args.length;i+=2){ map[args[i]] = args[i+1]; }
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(mapPath, JSON.stringify(map, null, 2));
console.log('Updated', mapPath);
console.log(JSON.stringify(map, null, 2));
