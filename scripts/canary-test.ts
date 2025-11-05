#!/usr/bin/env tsx
// Quick canary test - runs pairing and prints only key metrics
// Usage: npm run canary [analysis.json] [output.json]

import { runPairing } from '../src/pairing/runPairing.js';
import OpenAI from 'openai';
import fs from 'fs';

const analysisPath = process.argv[2] || 'analysis.json';
const outputPath = process.argv[3] || 'canary-pairing.json';

console.log('🐦 CANARY TEST');
console.log('═══════════════════════════════════════════════════════\n');

const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'dummy' });

const startTime = Date.now();
const { result, metrics } = await runPairing({ client, analysis });
const totalMs = Date.now() - startTime;

// Write output
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
fs.writeFileSync(outputPath.replace('.json', '-metrics.json'), JSON.stringify(metrics, null, 2));

// Print summary
console.log('\n📊 CANARY RESULTS');
console.log('═══════════════════════════════════════════════════════');
console.log(`Images:      ${metrics.totals.images} (${metrics.totals.fronts} fronts, ${metrics.totals.backs} backs)`);
console.log(`Paired:      ${result.pairs.length}/${metrics.totals.fronts} (${((result.pairs.length / metrics.totals.fronts) * 100).toFixed(1)}%)`);
console.log(`Auto-pairs:  ${metrics.totals.autoPairs} (${((metrics.totals.autoPairs / metrics.totals.fronts) * 100).toFixed(1)}%)`);
console.log(`Model pairs: ${metrics.totals.modelPairs} (${((metrics.totals.modelPairs / (metrics.totals.autoPairs + metrics.totals.modelPairs)) * 100).toFixed(1)}% GPT)`);
console.log(`Singletons:  ${result.singletons.length} (${((result.singletons.length / metrics.totals.fronts) * 100).toFixed(1)}%)`);
console.log(`Products:    ${result.products.length} (with ${result.products.reduce((acc, p) => acc + p.extras.length, 0)} extras)`);
console.log(`Duration:    ${totalMs}ms (${((totalMs / metrics.totals.images) * 100).toFixed(1)}ms per 100 images)`);

// SLO checks
console.log('\n✅ SLO CHECKS');
console.log('═══════════════════════════════════════════════════════');
const pairRate = (result.pairs.length / metrics.totals.fronts) * 100;
const singletonRate = (result.singletons.length / metrics.totals.fronts) * 100;
const gptRate = (metrics.totals.modelPairs / (metrics.totals.autoPairs + metrics.totals.modelPairs)) * 100;
const runtimePer100 = (totalMs / metrics.totals.images) * 100;

console.log(`Pair rate:      ${pairRate.toFixed(1)}% ${pairRate >= 98 ? '✓' : '✗ (target ≥98%)'}`);
console.log(`Singleton rate: ${singletonRate.toFixed(1)}% ${singletonRate <= 2 ? '✓' : '✗ (target ≤2%)'}`);
console.log(`GPT usage:      ${gptRate.toFixed(1)}% ${gptRate <= 2 ? '✓' : '✗ (target ≤2%)'}`);
console.log(`Runtime:        ${runtimePer100.toFixed(1)}ms/100img ${runtimePer100 <= 75 ? '✓' : '✗ (target ≤75ms)'}`);

// Go/No-Go decision
console.log('\n🚦 GO/NO-GO DECISION');
console.log('═══════════════════════════════════════════════════════');
const allPassed = pairRate >= 98 && singletonRate <= 2 && gptRate <= 2 && runtimePer100 <= 75;
if (allPassed) {
  console.log('✅ CANARY PASSED - Ready for larger batch');
  process.exit(0);
} else {
  console.log('❌ CANARY FAILED - Review metrics and adjust thresholds');
  console.log('\nSuggested actions:');
  if (pairRate < 98) console.log('  - Lower PAIR_AUTO_SCORE or PAIR_AUTO_HAIR_SCORE');
  if (singletonRate > 2) console.log('  - Review singleton reasons in metrics file');
  if (gptRate > 2) console.log('  - Increase auto-pair coverage or set PAIR_DISABLE_TIEBREAK=1');
  if (runtimePer100 > 75) console.log('  - Check batch size (should be ≤200 images)');
  process.exit(1);
}
