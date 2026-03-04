#!/usr/bin/env tsx
/**
 * CI guard: no new TypeScript files may be added to src/lib/.
 *
 * src/lib/ is a FROZEN legacy directory.  New shared utilities must go into
 * packages/core/src/ or src/services/ instead (see docs/architecture.md).
 *
 * This script compares the current contents of src/lib/ against the baseline
 * manifest at scripts/src-lib-baseline.txt.  Any file present in the directory
 * but NOT in the baseline is treated as a violation.
 *
 * To CREATE a new file in src/lib/ you must:
 *   1. Get an architecture review confirming it cannot go elsewhere.
 *   2. Add the new path to scripts/src-lib-baseline.txt.
 *   3. Update docs/architecture.md if the decision changes a documented rule.
 *
 * Usage:
 *   tsx scripts/check-structure.ts
 *   npm run check:structure
 *
 * Exit code 0 = pass, 1 = violations found.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(__dirname, '..');

const libDir = join(root, 'src', 'lib');
const baselineFile = join(__dirname, 'src-lib-baseline.txt');

if (!existsSync(baselineFile)) {
  console.error(`[FAIL] Baseline file not found: ${baselineFile}`);
  process.exit(1);
}

const baseline = new Set(
  readFileSync(baselineFile, 'utf8')
    .split('\n')
    .map(l => l.trim().replace(/\\/g, '/').toLowerCase())
    .filter(l => l.includes('.')), // skip blank lines and dir-only entries
);

/** Recursively yield all .ts files, skipping node_modules and dist. */
function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      yield* walkTs(full);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      yield full;
    }
  }
}

const current = [...walkTs(libDir)]
  .map(f => relative(root, f).replace(/\\/g, '/').toLowerCase())
  .sort();

const violations = current.filter(f => !baseline.has(f));

if (violations.length > 0) {
  console.error(`\n[FAIL] ${violations.length} new file(s) detected in src/lib/ (frozen directory):\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error('\nNew shared utilities must go into packages/core/src/ or src/services/.');
  console.error('See docs/architecture.md#where-do-i-put-x for guidance.');
  console.error('\nIf the file legitimately belongs in src/lib/ (rare), add it to');
  console.error('scripts/src-lib-baseline.txt after an architecture review.\n');
  process.exit(1);
}

console.log(`[PASS] src/lib/ structure is clean - no new files detected (${current.length} baseline files).`);
