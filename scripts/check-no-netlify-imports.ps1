#!/usr/bin/env pwsh
<#
.SYNOPSIS
  CI guard: verify that apps/api and packages/core contain no Netlify-specific imports.

.DESCRIPTION
  These layers must stay platform-agnostic.  Any import from Netlify's function
  runtime, handler types, or the netlify/functions directory is a violation.

  The guard intentionally does NOT scan netlify/functions/ itself — those files
  are allowed to import from each other while the Netlify → Express migration
  is in progress.

.EXIT CODE
  0  All clear — no Netlify imports found.
  1  Violations found — list is printed to stdout.
#>

$ErrorActionPreference = 'Continue'

# Patterns are matched line-by-line against source files.
# Each is a simple substring or regex that must appear in an import/require context.
# We scan each line and skip pure comment lines (starting with // or *).
function Test-LineIsViolation {
  param([string]$line)

  # Skip comment-only lines
  $trimmed = $line.TrimStart()
  if ($trimmed.StartsWith('//') -or $trimmed.StartsWith('*') -or $trimmed.StartsWith('#')) {
    return $false
  }

  # Flag any line that has an import/require statement referencing Netlify
  if ($trimmed -match 'import\s' -and $trimmed -match 'netlify') { return $true }
  if ($trimmed -match 'require\(' -and $trimmed -match 'netlify') { return $true }
  if ($trimmed -match 'from\s' -and $trimmed -match '@netlify') { return $true }

  return $false
}

$searchRoots = @(
  'apps/api',
  'packages/core',
  'packages/shared'
)

$violations = @()

foreach ($root in $searchRoots) {
  if (-not (Test-Path $root)) { continue }

  $files = Get-ChildItem -Path $root -Recurse -Include '*.ts','*.js' -File
  foreach ($file in $files) {
    $lines = Get-Content $file.FullName -ErrorAction SilentlyContinue
    if (-not $lines) { continue }

    foreach ($line in $lines) {
      if (Test-LineIsViolation $line) {
        $violations += "$($file.FullName) : $($line.Trim())"
        break   # one violation per file is enough
      }
    }
  }
}

if ($violations.Count -gt 0) {
  Write-Host ''
  Write-Host '[FAIL] Netlify imports found in platform-agnostic layers:' -ForegroundColor Red
  $violations | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  Write-Host ''
  Write-Host 'These files must not import from netlify/functions or @netlify/.' -ForegroundColor Red
  Write-Host 'Move shared logic to src/services/ or packages/core/ instead.' -ForegroundColor Red
  exit 1
}

Write-Host '[PASS] No Netlify imports in apps/api or packages/core.' -ForegroundColor Green
exit 0
