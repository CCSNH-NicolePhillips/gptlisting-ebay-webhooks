#!/usr/bin/env pwsh
<#
.SYNOPSIS
  CI guard: every netlify/functions/*.ts file must be listed in
  docs/endpoints-migration.md.

.DESCRIPTION
  Run with:
    powershell -File scripts/check-inventory.ps1

  If a new Netlify function is added without updating the inventory, this
  script exits with code 1 and lists the unlisted functions.

  To add a new function to the inventory, add a row to the relevant
  section of docs/endpoints-migration.md (Status = not-started).
  See docs/migration-checklist.md for the full migration workflow.
#>

$ErrorActionPreference = 'Stop'
$root        = Split-Path $PSScriptRoot -Parent
$functionsDir = Join-Path (Join-Path $root 'netlify') 'functions'
$inventoryFile = Join-Path (Join-Path $root 'docs') 'endpoints-migration.md'

if (-not (Test-Path $inventoryFile)) {
  Write-Error "Inventory file not found: $inventoryFile"
  exit 1
}

$inventoryContent = Get-Content $inventoryFile -Raw

# Collect all function names from the filesystem
$allNames = Get-ChildItem (Join-Path $functionsDir '*.ts') |
  Where-Object { -not $_.Name.StartsWith('_') } |
  Select-Object -ExpandProperty BaseName |
  Sort-Object

$missing = @()

foreach ($name in $allNames) {
  # Check that the inventory contains the canonical path reference
  $needle = "netlify/functions/$name.ts"
  if (-not $inventoryContent.Contains($needle)) {
    $missing += $name
  }
}

if ($missing.Count -gt 0) {
  Write-Host ""
  Write-Host "[FAIL] $($missing.Count) netlify function(s) not listed in endpoints-migration.md:"
  Write-Host ""
  foreach ($name in $missing) {
    $oldUrl = "/.netlify/functions/$name"
    Write-Host "  | netlify/functions/$name.ts | $oldUrl | /api/... | not-started | |"
  }
  Write-Host ""
  Write-Host "Add the rows above to the appropriate section of docs/endpoints-migration.md."
  Write-Host "See docs/migration-checklist.md for the full migration workflow."
  Write-Host ""
  exit 1
}

Write-Host "[PASS] All $($allNames.Count) netlify functions are listed in endpoints-migration.md."
exit 0
