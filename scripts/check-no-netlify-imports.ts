#!/usr/bin/env tsx
/**
 * CI guard: verify that apps/api and packages/* contain no Netlify-specific imports.
 *
 * These layers must stay platform-agnostic.  Any import from Netlify's function
 * runtime, handler types, or the netlify/functions directory is a violation.
 *
 * The guard intentionally does NOT scan netlify/functions/ itself — those files
 * are allowed to import from each other while the Netlify → Express migration
 * is in progress.
 *
 * Usage:
 *   tsx scripts/check-no-netlify-imports.ts
 *   npm run check:no-netlify
 *
 * Exit code 0 = pass, 1 = violations found.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(__dirname, '..');

const SEARCH_ROOTS = ['apps/api', 'packages/core', 'packages/shared'];

/** Recursively yield all .ts / .js files, skipping node_modules and dist. */
function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      yield* walkFiles(full);
    } else if (entry.isFile() && /\.[jt]sx?$/.test(entry.name)) {
      yield full;
    }
  }
}

function isViolation(line: string): boolean {
  const t = line.trimStart();
  // Skip pure comment lines
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('#')) return false;
  // import ... 'netlify...' or from 'netlify...'
  if (/import\s/.test(t) && /netlify/i.test(t)) return true;
  if (/require\(/.test(t) && /netlify/i.test(t)) return true;
  if (/from\s/.test(t) && /@netlify/.test(t)) return true;
  return false;
}

const violations: string[] = [];

for (const searchRoot of SEARCH_ROOTS) {
  const absRoot = join(root, searchRoot);
  if (!existsSync(absRoot)) continue;

  for (const file of walkFiles(absRoot)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      if (isViolation(line)) {
        violations.push(`${file.replace(root + '/', '').replace(root + '\\', '')} : ${line.trim()}`);
        break; // one violation per file is enough
      }
    }
  }
}

if (violations.length > 0) {
  console.error('\n[FAIL] Netlify imports found in platform-agnostic layers:');
  for (const v of violations) console.error(`  ${v}`);
  console.error('\nThese files must not import from netlify/functions or @netlify/.');
  console.error('Move shared logic to src/services/ or packages/core/ instead.\n');
  process.exit(1);
}

console.log('[PASS] No Netlify imports in apps/api or packages/core.');
