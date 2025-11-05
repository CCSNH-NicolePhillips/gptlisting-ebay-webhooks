import {buildFeatures} from './dist/src/pairing/featurePrep.js';
import {buildCandidates} from './dist/src/pairing/candidates.js';
import fs from 'fs';

const data = JSON.parse(fs.readFileSync('analysis.json','utf8'));
const features = buildFeatures(data);
const candidates = buildCandidates(features, 4);

console.log('R+Co front candidates:', candidates['EBAY/asd32q.jpg']);

console.log('\nFeature details:');
for (const [url, feat] of features.entries()) {
  if (url.includes('asd32q') || url.includes('azdfkuj')) {
    console.log(`${url}:`, {
      role: feat.role,
      brandNorm: feat.brandNorm,
      packagingHint: feat.packagingHint,
      categoryPath: feat.categoryPath,
      textHasIngredients: /ingredients:/i.test(feat.textExtracted),
      textHasApplyHair: /apply.*hair/i.test(feat.textExtracted)
    });
  }
}
