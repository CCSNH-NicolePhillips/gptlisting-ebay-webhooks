/**
 * list-netlify-functions.ts
 *
 * Scans netlify/functions/*.ts and prints a markdown table of all function
 * names.  Run with:
 *   npx tsx scripts/list-netlify-functions.ts
 *   npx tsx scripts/list-netlify-functions.ts --diff   # show names NOT in inventory
 *
 * Output can be pasted into docs/endpoints-migration.md or used to diff the
 * inventory against the actual filesystem.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'netlify', 'functions');
const INVENTORY_FILE = path.join(ROOT, 'docs', 'endpoints-migration.md');

// ── helpers ────────────────────────────────────────────────────────────────

function listFunctions(): string[] {
  return fs
    .readdirSync(FUNCTIONS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();
}

function readInventoryNames(): Set<string> {
  if (!fs.existsSync(INVENTORY_FILE)) return new Set();
  const content = fs.readFileSync(INVENTORY_FILE, 'utf8');
  const names = new Set<string>();
  // Match lines like `| netlify/functions/foo.ts |` (first column)
  for (const line of content.split('\n')) {
    const m = line.match(/\|\s*netlify\/functions\/([^.|\s]+)\.ts\s*\|/);
    if (m) names.add(m[1]);
  }
  return names;
}

// ── main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const diffMode = args.includes('--diff');
const functions = listFunctions();

if (diffMode) {
  // --diff mode: show functions NOT listed in the inventory
  const inventoried = readInventoryNames();
  const missing = functions.filter((fn) => !inventoried.has(fn));

  if (missing.length === 0) {
    console.log('✅  All netlify functions are listed in endpoints-migration.md');
    process.exit(0);
  } else {
    console.error(
      `❌  ${missing.length} function(s) not in endpoints-migration.md:\n`,
    );
    for (const fn of missing) {
      const oldUrl = `/.netlify/functions/${fn}`;
      console.error(
        `| netlify/functions/${fn}.ts | ${oldUrl} | /api/... | not-started | |`,
      );
    }
    process.exit(1);
  }
} else {
  // Default mode: print full markdown table rows (no-header, ready to paste)
  console.log(
    '| Function file | Old URL | New target URL | Status | Notes |',
  );
  console.log('|---|---|---|---|---|');
  for (const fn of functions) {
    const oldUrl = `/.netlify/functions/${fn}`;
    console.log(
      `| netlify/functions/${fn}.ts | ${oldUrl} | /api/... | not-started | |`,
    );
  }
  console.log(`\n<!-- ${functions.length} functions total -->`);
}
