#!/usr/bin/env pwsh
<#
.SYNOPSIS
  CI guard: no new TypeScript files may be added to src/lib/.

.DESCRIPTION
  src/lib/ is a FROZEN legacy directory.  New shared utilities must go into
  packages/core/src/ or src/services/ instead (see docs/architecture.md).

  This script compares the current contents of src/lib/ against the baseline
  manifest at scripts/src-lib-baseline.txt.  Any file present in the directory
  but NOT in the baseline is treated as a violation.

  To CREATE a new file in src/lib/ you must:
    1. Get an architecture review confirming it cannot go elsewhere.
    2. Add the new path to scripts/src-lib-baseline.txt.
    3. Update docs/architecture.md if the decision changes a documented rule.

  Note: the inventory guard (check-inventory.ps1) is a separate check for
  netlify/functions/*.ts files.

.EXIT CODE
  0  All clear — no new src/lib files found.
  1  Violations found — list is printed to stdout.

.USAGE
  powershell -File scripts/check-structure.ps1
  # or via npm:
  npm run check:structure
#>

$ErrorActionPreference = 'Continue'
$root         = Split-Path $PSScriptRoot -Parent
$libDir       = Join-Path (Join-Path $root 'src') 'lib'
$baselineFile = Join-Path $PSScriptRoot 'src-lib-baseline.txt'

if (-not (Test-Path $baselineFile)) {
  Write-Host "[FAIL] Baseline file not found: $baselineFile"
  exit 1
}

# Load baseline (normalise to forward-slash, lowercase, trim)
$baseline = Get-Content $baselineFile |
  ForEach-Object { $_.Trim().Replace('\', '/').ToLowerInvariant() } |
  Where-Object { $_ -match '\.' }  # only lines with an extension (skip blank or dir/)

$baselineSet = [System.Collections.Generic.HashSet[string]]::new(
  [System.StringComparer]::OrdinalIgnoreCase
)
foreach ($entry in $baseline) { [void]$baselineSet.Add($entry) }

# Collect all .ts files currently in src/lib/
$current = Get-ChildItem -Path $libDir -Filter '*.ts' -Recurse |
  Where-Object {
    $_.FullName -notmatch '\\node_modules\\' -and
    $_.FullName -notmatch '\\dist\\'
  } |
  ForEach-Object {
    $_.FullName.Replace($root + '\', '').Replace('\', '/').ToLowerInvariant()
  } |
  Sort-Object

$violations = @()

foreach ($file in $current) {
  if (-not $baselineSet.Contains($file)) {
    $violations += $file
  }
}

if ($violations.Count -gt 0) {
  Write-Host ""
  Write-Host "[FAIL] $($violations.Count) new file(s) detected in src/lib/ (frozen directory):"
  Write-Host ""
  foreach ($v in $violations) {
    Write-Host "  $v"
  }
  Write-Host ""
  Write-Host "New shared utilities must go into packages/core/src/ or src/services/."
  Write-Host "See docs/architecture.md#where-do-i-put-x for guidance."
  Write-Host ""
  Write-Host "If the file legitimately belongs in src/lib/ (rare), add it to"
  Write-Host "scripts/src-lib-baseline.txt after an architecture review."
  Write-Host ""
  exit 1
}

Write-Host "[PASS] src/lib/ structure is clean - no new files detected ($($current.Count) baseline files)."
exit 0
