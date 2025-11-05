// Golden dataset regression test
// Runs pairing on golden/analysis.json and compares output to expected results
// Exits with code 1 if:
// - Pair count changes
// - Singleton count changes  
// - Product count changes
// - Any critical metrics regress

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runPairing } from '../src/pairing/runPairing.js';
import { PairingResult, parsePairingResult } from '../src/pairing/schema.js';
import { PairingMetrics } from '../src/pairing/metrics.js';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ComparisonResult {
  passed: boolean;
  diffs: string[];
}

function compareResults(
  actual: PairingResult,
  expected: PairingResult
): ComparisonResult {
  const diffs: string[] = [];

  // Check pair counts
  if (actual.pairs.length !== expected.pairs.length) {
    diffs.push(`REGRESSION pairs: ${expected.pairs.length} -> ${actual.pairs.length}`);
  }

  // Check singleton counts
  if (actual.singletons.length !== expected.singletons.length) {
    diffs.push(`REGRESSION singletons: ${expected.singletons.length} -> ${actual.singletons.length}`);
  }

  // Check product counts
  if (actual.products.length !== expected.products.length) {
    diffs.push(`REGRESSION products: ${expected.products.length} -> ${actual.products.length}`);
  }

  return {
    passed: diffs.length === 0,
    diffs
  };
}

function compareMetrics(
  actual: PairingMetrics,
  expected: PairingMetrics
): ComparisonResult {
  const diffs: string[] = [];

  // Check critical counts
  if (actual.totals.fronts !== expected.totals.fronts) {
    diffs.push(`METRICS REGRESSION fronts: ${expected.totals.fronts} -> ${actual.totals.fronts}`);
  }

  if (actual.totals.backs !== expected.totals.backs) {
    diffs.push(`METRICS REGRESSION backs: ${expected.totals.backs} -> ${actual.totals.backs}`);
  }

  if (actual.totals.autoPairs !== expected.totals.autoPairs) {
    diffs.push(`METRICS REGRESSION autoPairs: ${expected.totals.autoPairs} -> ${actual.totals.autoPairs}`);
  }

  if (actual.totals.modelPairs !== expected.totals.modelPairs) {
    diffs.push(`METRICS REGRESSION modelPairs: ${expected.totals.modelPairs} -> ${actual.totals.modelPairs}`);
  }

  if (actual.totals.singletons !== expected.totals.singletons) {
    diffs.push(`METRICS REGRESSION singletons: ${expected.totals.singletons} -> ${actual.totals.singletons}`);
  }

  return {
    passed: diffs.length === 0,
    diffs
  };
}

async function main() {
  const goldenDir = path.join(__dirname, '../tests/golden');
  const analysisPath = path.join(goldenDir, 'analysis.json');
  const expectedPairingPath = path.join(goldenDir, 'pairing-expected.json');
  const expectedMetricsPath = path.join(goldenDir, 'metrics-expected.json');

  console.log('🔍 Running golden dataset verification...\n');

  // Load inputs
  const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
  const expectedPairing: PairingResult = parsePairingResult(
    JSON.parse(fs.readFileSync(expectedPairingPath, 'utf-8'))
  );
  const expectedMetrics: PairingMetrics = JSON.parse(
    fs.readFileSync(expectedMetricsPath, 'utf-8')
  );

  // Run pairing
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'dummy' });
  const { result: actualPairing, metrics: actualMetrics } = await runPairing({
    client,
    analysis,
    model: 'gpt-4o-mini'
  });

  // Compare results
  const pairingComparison = compareResults(actualPairing, expectedPairing);
  const metricsComparison = compareMetrics(actualMetrics, expectedMetrics);

  // Print results
  console.log('\n📊 Golden Dataset Comparison:\n');
  console.log(`✅ Pairs: ${actualPairing.pairs.length} (expected: ${expectedPairing.pairs.length})`);
  console.log(`✅ Products: ${actualPairing.products.length} (expected: ${expectedPairing.products.length})`);
  console.log(`✅ Singletons: ${actualPairing.singletons.length} (expected: ${expectedPairing.singletons.length})`);
  console.log(`✅ AutoPairs: ${actualMetrics.totals.autoPairs} (expected: ${expectedMetrics.totals.autoPairs})`);
  console.log(`✅ ModelPairs: ${actualMetrics.totals.modelPairs} (expected: ${expectedMetrics.totals.modelPairs})`);

  // Print diffs if any
  if (pairingComparison.diffs.length > 0) {
    console.log('\n❌ PAIRING REGRESSIONS:');
    pairingComparison.diffs.forEach(diff => console.log(`  ${diff}`));
  }

  if (metricsComparison.diffs.length > 0) {
    console.log('\n❌ METRICS REGRESSIONS:');
    metricsComparison.diffs.forEach(diff => console.log(`  ${diff}`));
  }

  // Exit with appropriate code
  const passed = pairingComparison.passed && metricsComparison.passed;
  if (passed) {
    console.log('\n✅ Golden dataset verification PASSED\n');
    process.exit(0);
  } else {
    console.log('\n❌ Golden dataset verification FAILED\n');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
