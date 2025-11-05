// Pretty-print pairing metrics for quick analysis

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PairingMetrics {
  totals: {
    images: number;
    fronts: number;
    backs: number;
    candidates: number;
    autoPairs: number;
    modelPairs: number;
    singletons: number;
  };
  byBrand: Record<string, { fronts: number; paired: number; pairRate: number }>;
  reasons: Record<string, number>;
  thresholds: any;
  timestamp: string;
  durationMs: number;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function printMetrics(metrics: PairingMetrics) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊  PAIRING METRICS SUMMARY');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Totals
  const pairRate = metrics.totals.fronts > 0 
    ? metrics.totals.autoPairs + metrics.totals.modelPairs / metrics.totals.fronts 
    : 0;
  const singletonRate = metrics.totals.fronts > 0
    ? metrics.totals.singletons / metrics.totals.fronts
    : 0;
  const gptRate = metrics.totals.autoPairs + metrics.totals.modelPairs > 0
    ? metrics.totals.modelPairs / (metrics.totals.autoPairs + metrics.totals.modelPairs)
    : 0;

  console.log('🎯 Overall Performance:');
  console.log(`   Images:      ${metrics.totals.images} (${metrics.totals.fronts} fronts, ${metrics.totals.backs} backs)`);
  console.log(`   Paired:      ${metrics.totals.autoPairs + metrics.totals.modelPairs}/${metrics.totals.fronts} (${formatPercent(pairRate)})`);
  console.log(`   Auto-pairs:  ${metrics.totals.autoPairs} (${formatPercent(metrics.totals.autoPairs / metrics.totals.fronts)})`);
  console.log(`   Model pairs: ${metrics.totals.modelPairs} (GPT: ${formatPercent(gptRate)})`);
  console.log(`   Singletons:  ${metrics.totals.singletons} (${formatPercent(singletonRate)})`);
  console.log(`   Duration:    ${formatDuration(metrics.durationMs)}\n`);

  // SLO compliance
  const pairRatePct = pairRate * 100;
  const singletonRatePct = singletonRate * 100;
  const gptRatePct = gptRate * 100;
  
  console.log('✅ SLO Compliance:');
  console.log(`   Pair rate:       ${formatPercent(pairRate)} ${pairRatePct >= 98 ? '✓' : '✗ (target ≥98%)'}`);
  console.log(`   Singleton rate:  ${formatPercent(singletonRate)} ${singletonRatePct <= 2 ? '✓' : '✗ (target ≤2%)'}`);
  console.log(`   GPT usage:       ${formatPercent(gptRate)} ${gptRatePct <= 2 ? '✓' : '✗ (target ≤2%)'}`);
  console.log(`   Runtime/100img:  ${formatDuration((metrics.durationMs / metrics.totals.images) * 100)} ${(metrics.durationMs / metrics.totals.images) * 100 <= 75 ? '✓' : '✗ (target ≤75ms)'}\n`);

  // By-brand breakdown
  if (Object.keys(metrics.byBrand).length > 0) {
    console.log('📦 By-Brand Breakdown:');
    const brands = Object.entries(metrics.byBrand)
      .sort((a, b) => b[1].fronts - a[1].fronts);
    
    for (const [brand, stats] of brands) {
      const rate = stats.pairRate;
      const status = rate >= 0.98 ? '✓' : rate >= 0.95 ? '⚠' : '✗';
      console.log(`   ${status} ${brand.padEnd(25)} ${stats.paired}/${stats.fronts} (${formatPercent(rate)})`);
    }
    console.log();
  }

  // Singleton reasons
  if (Object.keys(metrics.reasons).length > 0) {
    console.log('🔍 Singleton Reasons:');
    const reasons = Object.entries(metrics.reasons)
      .sort((a, b) => b[1] - a[1]);
    
    for (const [reason, count] of reasons) {
      console.log(`   • ${reason.padEnd(30)} ${count}`);
    }
    console.log();
  }

  // Thresholds
  console.log('⚙️  Active Thresholds:');
  console.log(`   Engine version:    ${metrics.thresholds.engineVersion || 'N/A'}`);
  console.log(`   Min preScore:      ${metrics.thresholds.minPreScore}`);
  console.log(`   Auto-pair:         score=${metrics.thresholds.autoPairScore}, gap=${metrics.thresholds.autoPairGap}`);
  console.log(`   Auto-pair (hair):  score=${metrics.thresholds.autoPairHairScore}, gap=${metrics.thresholds.autoPairHairGap}\n`);

  // Timestamp
  console.log(`📅 Run: ${new Date(metrics.timestamp).toLocaleString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

async function main() {
  const metricsPath = process.argv[2] || 'pairing-metrics.json';
  
  if (!fs.existsSync(metricsPath)) {
    console.error(`❌ Metrics file not found: ${metricsPath}`);
    console.error('Usage: npm run metrics:print [path/to/metrics.json]');
    process.exit(1);
  }

  const metrics: PairingMetrics = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
  printMetrics(metrics);
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
