#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Verify that no app code imports delivered-pricing, pricing-compute, or
    related internal helpers directly.

.DESCRIPTION
    After the Chunk 9 cleanup:
    - All Netlify functions must route pricing through src/lib/pricing/index.ts
      (getPricingDecision only).
    - src/lib/*.ts helpers may import from src/lib/pricing/legacy-compute.ts
      or src/lib/pricing/ebay-price-math.ts for raw math, but not from
      delivered-pricing.ts or pricing-compute.ts directly.
    - Tests in tests/ are exempt (they test math via the backward-compat stub).

.APPROVED EXCEPTIONS
    src/lib/pricing-compute.ts   — the stub itself; it re-exports from the
                                   new sub-modules.
    src/lib/delivered-pricing.ts — the implementation; nothing else may import it.
    src/lib/pricing/             — canonical sub-modules; may import each other.
    src/lib/price-lookup.ts      — has its own approved pattern (ebay-price-math).

.USAGE
    powershell -ExecutionPolicy Bypass -File scripts/check-forbidden-imports.ps1
    # Exit code 0 = clean, 1 = violations found
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Configuration ─────────────────────────────────────────────────────────────

$root = $PSScriptRoot | Split-Path   # workspace root

# Patterns that constitute a forbidden import (regex).
# We match the import path, not the binding name.
$forbiddenPatterns = @(
    "from\s+[`"'][^`"']*delivered-pricing\.js[`"']",
    "from\s+[`"'][^`"']*pricing-compute\.js[`"']"
)

# Files / directories ALLOWED to contain the patterns above.
# Paths are relative to $root and compared case-insensitively.
$allowList = @(
    # The modules themselves (implementations / stubs)
    'src/lib/delivered-pricing.ts',
    'src/lib/pricing-compute.ts',
    # pricing/ sub-modules are the canonical consumers and may import both
    'src/lib/pricing/'
)

# Scopes to check (relative globs from $root)
$checkGlobs = @(
    'netlify/functions/**/*.ts',
    'src/**/*.ts'
)

# ── Helpers ───────────────────────────────────────────────────────────────────

function IsAllowed([string]$relPath) {
    $normalised = $relPath.Replace('\', '/')
    foreach ($entry in $allowList) {
        $e = $entry.Replace('\', '/')
        if ($e.EndsWith('/')) {
            if ($normalised.StartsWith($e, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        } else {
            if ($normalised -ieq $e) { return $true }
        }
    }
    return $false
}

# ── Main ──────────────────────────────────────────────────────────────────────

$violations = [System.Collections.Generic.List[string]]::new()

foreach ($glob in $checkGlobs) {
    $files = Get-ChildItem -Path $root -Filter '*.ts' -Recurse |
        Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\dist\\' }

    foreach ($file in $files) {
        $rel = $file.FullName.Substring($root.Length + 1).Replace('\', '/')

        # Only check files inside the globs (simple prefix check)
        $inScope = ($rel.StartsWith('netlify/functions/') -or $rel.StartsWith('src/'))
        if (-not $inScope) { continue }

        if (IsAllowed $rel) { continue }

        $content = Get-Content $file.FullName -Raw
        foreach ($pattern in $forbiddenPatterns) {
            if ($content -match $pattern) {
                $violations.Add("  FORBIDDEN: $rel  (matches /$pattern/)")
            }
        }
    }
}

# ── Report ────────────────────────────────────────────────────────────────────

if ($violations.Count -eq 0) {
    Write-Host "✅  No forbidden pricing imports found." -ForegroundColor Green
    exit 0
} else {
    Write-Host "❌  Forbidden direct imports of delivered-pricing / pricing-compute detected:" -ForegroundColor Red
    $violations | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
    Write-Host ""
    Write-Host "All app code must import from src/lib/pricing/index.ts instead." -ForegroundColor Red
    exit 1
}
