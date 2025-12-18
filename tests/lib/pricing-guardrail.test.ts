/**
 * Guardrail Test: Ensure No Double Pricing
 * Verifies computeEbayItemPriceCents is only called from taxonomy-map.ts (single canonical location)
 */

import { execSync } from 'child_process';
import * as path from 'path';

describe('C) Pricing Guardrail: No Double Pricing', () => {
  it('computeEbayItemPriceCents only called from taxonomy-map.ts', () => {
    const workspaceRoot = path.resolve(__dirname, '../..');
    
    // Search for computeEbayItemPriceCents calls in production code (exclude tests)
    const grepCommand = `git grep -n "computeEbayItemPriceCents" -- "src/**/*.ts" "src/**/*.js" "netlify/**/*.ts" "netlify/**/*.js"`;
    
    let grepOutput: string;
    try {
      grepOutput = execSync(grepCommand, {
        cwd: workspaceRoot,
        encoding: 'utf8',
      });
    } catch (error: any) {
      // grep returns exit code 1 when no matches found
      if (error.status === 1 && error.stdout === '') {
        grepOutput = '';
      } else {
        throw error;
      }
    }
    
    // Parse results
    const lines = grepOutput.split('\n').filter(line => line.trim());
    
    // Filter out definition/import lines
    const callSites = lines.filter(line => {
      // Exclude the function definition itself
      if (line.includes('export function computeEbayItemPriceCents')) return false;
      if (line.includes('export { computeEbayItemPriceCents }')) return false;
      // Exclude imports
      if (line.includes('import') && line.includes('computeEbayItemPriceCents')) return false;
      // Exclude comments (including JSDoc and inline comments after colon)
      const codeContent = line.split(':')[2] || ''; // Get content after filename:linenum:
      if (!codeContent.trim()) return false;
      if (codeContent.trim().startsWith('//')) return false;
      if (codeContent.trim().startsWith('*')) return false;
      if (codeContent.trim().startsWith('/*')) return false;
      if (codeContent.includes('@deprecated')) return false;
      
      return true;
    });
    
    // Verify all call sites are in taxonomy-map.ts
    const invalidCallSites = callSites.filter(line => !line.includes('taxonomy-map.ts'));
    
    if (invalidCallSites.length > 0) {
      const message = [
        'ERROR: computeEbayItemPriceCents called from locations other than taxonomy-map.ts!',
        'This violates the single canonical pricing location principle.',
        '',
        'Invalid call sites:',
        ...invalidCallSites.map(line => `  - ${line}`),
        '',
        'REQUIRED ACTION: Remove these calls and use taxonomy-map.ts instead.',
      ].join('\n');
      
      throw new Error(message);
    }
    
    // Verify taxonomy-map.ts DOES call it (sanity check)
    const taxonomyMapCalls = callSites.filter(line => line.includes('taxonomy-map.ts'));
    expect(taxonomyMapCalls.length).toBeGreaterThan(0);
    
    // Success: Only taxonomy-map.ts calls computeEbayItemPriceCents
    console.log(`✓ Verified: computeEbayItemPriceCents only called from taxonomy-map.ts (${taxonomyMapCalls.length} call sites)`);
  });
});
