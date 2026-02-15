import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

const buf = fs.readFileSync('C:/Users/hanri/Downloads/eBay_Pricing_System_Plan.pdf');
const parser = new PDFParse(buf);
const data = await parser.parse();
fs.writeFileSync('C:/Users/hanri/Downloads/eBay_Pricing_System_Plan.txt', data.text);
console.log('Pages:', data.numpages, 'Chars:', data.text.length);
