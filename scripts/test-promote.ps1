# Test promotion for a specific SKU
# Usage: .\scripts\test-promote.ps1 -sku "RZI6Cmiti9abcysa"

param(
    [Parameter(Mandatory=$true)]
    [string]$sku,
    
    [Parameter(Mandatory=$false)]
    [int]$adRate = 5
)

# Get your auth token from browser (open DevTools > Application > Local Storage > copy the auth token)
Write-Host "Enter your auth token (from browser localStorage 'auth_token'):" -ForegroundColor Yellow
$token = Read-Host

if (-not $token) {
    Write-Host "Error: Token is required" -ForegroundColor Red
    exit 1
}

$url = "https://gptlisting-ebay-webhooks.netlify.app/.netlify/functions/promote-drafts"

$body = @{
    skus = @($sku)
    adRate = $adRate
} | ConvertTo-Json

$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
}

Write-Host "`nPromoting SKU: $sku at $adRate% ad rate..." -ForegroundColor Cyan

try {
    $response = Invoke-RestMethod -Uri $url -Method POST -Headers $headers -Body $body
    Write-Host "`nSuccess!" -ForegroundColor Green
    Write-Host ($response | ConvertTo-Json -Depth 10)
} catch {
    Write-Host "`nError:" -ForegroundColor Red
    Write-Host $_.Exception.Message
    if ($_.ErrorDetails.Message) {
        Write-Host $_.ErrorDetails.Message
    }
}
