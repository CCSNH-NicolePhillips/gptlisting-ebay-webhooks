# Runs the Node ESM repro script which exchanges refresh token and performs an inventory PUT
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/run_repro_inventory_put.ps1

$node = 'node'
$script = Join-Path -Path (Get-Location) -ChildPath 'scripts/repro_inventory_put.mjs'

Write-Output "Running $script with node..."
& $node --input-type=module -e "import('./$($script -replace '\\','/')).catch(e=>{console.error(e);process.exit(1)})" 2>&1 | ForEach-Object { Write-Output $_ }
