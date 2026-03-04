#!/usr/bin/env tsx
/**
 * CI guard: every netlify/functions/*.ts file must be listed in
 * docs/endpoints-migration.md.
 *
 * If a new Netlify function is added without updating the inventory, this
 * script exits with code 1 and lists the unlisted functions.
 *
 * To add a new function to the inventory, add a row to the relevant section
 * of docs/endpoints-migration.md (Status = not-started).
 * See docs/migration-checklist.md for the full migration workflow.
 *
 * Usage:
 *   tsx scripts/check-inventory.ts
 *   npm run check:inventory
 *
 * Exit code 0 = pass, 1 = violations found.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(__dirname, '..');

const functionsDir = join(root, 'netlify', 'functions');
const inventoryFile = join(root, 'docs', 'endpoints-migration.md');

if (!existsSync(inventoryFile)) {
  console.error(`[FAIL] Inventory file not found: ${inventoryFile}`);
  process.exit(1);
}

if (!existsSync(functionsDir)) {
  console.error(`[FAIL] Functions directory not found: ${functionsDir}`);
  process.exit(1);
}

const inventoryContent = readFileSync(inventoryFile, 'utf8');

// Collect all function names from the filesystem (exclude private _files)
const allNames = readdirSync(functionsDir)
  .filter(f => f.endsWith('.ts') && !f.startsWith('_'))
  .map(f => basename(f, '.ts'))
  .sort();

const missing: string[] = [];

for (const name of allNames) {
  const needle = `netlify/functions/${name}.ts`;
  if (!inventoryContent.includes(needle)) {
    missing.push(name);
  }
}

if (missing.length > 0) {
  console.error(`\n[FAIL] ${missing.length} netlify function(s) not listed in endpoints-migration.md:\n`);
  for (const name of missing) {
    const oldUrl = `/.netlify/functions/${name}`;
    console.error(`  | netlify/functions/${name}.ts | ${oldUrl} | /api/... | not-started | |`);
  }
  console.error('\nAdd the rows above to the appropriate section of docs/endpoints-migration.md.');
  console.error('See docs/migration-checklist.md for the full migration workflow.\n');
  process.exit(1);
}

console.log(`[PASS] All ${allNames.length} netlify functions are listed in endpoints-migration.md.`);
