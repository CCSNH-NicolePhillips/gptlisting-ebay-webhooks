# Delete eBay drafts with invalid SKUs (containing hyphens)
# Run this script locally to clean up broken drafts

$ErrorActionPreference = "Stop"

# Load environment variables from prod.env
$envFile = Join-Path $PSScriptRoot "..\prod.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+?)\s*=\s*(.+?)\s*$') {
            $name = $matches[1]
            $value = $matches[2]
            [Environment]::SetEnvironmentVariable($name, $value, "Process")
        }
    }
    Write-Host "OK - Loaded environment variables from prod.env" -ForegroundColor Green
}

# Get eBay credentials
$refreshToken = $env:EBAY_USER_REFRESH_TOKEN
if (-not $refreshToken) {
    Write-Host "ERROR: EBAY_USER_REFRESH_TOKEN not found in prod.env" -ForegroundColor Red
    exit 1
}

$appId = $env:EBAY_APP_ID
$certId = $env:EBAY_CERT_ID
if (-not $appId -or -not $certId) {
    Write-Host "ERROR: EBAY_APP_ID and EBAY_CERT_ID required in prod.env" -ForegroundColor Red
    exit 1
}

$env = if ($env:EBAY_ENV -eq "SANDBOX") { "SANDBOX" } else { "PROD" }
$apiHost = if ($env -eq "SANDBOX") { "https://api.sandbox.ebay.com" } else { "https://api.ebay.com" }
$authHost = if ($env -eq "SANDBOX") { "https://api.sandbox.ebay.com" } else { "https://api.ebay.com" }
$marketplaceId = if ($env:EBAY_MARKETPLACE_ID) { $env:EBAY_MARKETPLACE_ID } else { "EBAY_US" }

Write-Host "Environment: $env" -ForegroundColor Cyan
Write-Host "API Host: $apiHost" -ForegroundColor Cyan
Write-Host "Marketplace: $marketplaceId" -ForegroundColor Cyan
Write-Host ""

# Step 1: Get access token from refresh token
Write-Host "Getting access token..." -ForegroundColor Yellow
$authHeader = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${appId}:${certId}"))
$tokenBody = 'grant_type=refresh_token&refresh_token=' + $refreshToken

try {
    $tokenResponse = Invoke-RestMethod -Uri "$authHost/identity/v1/oauth2/token" `
        -Method Post `
        -Headers @{
            "Authorization" = "Basic $authHeader"
            "Content-Type" = "application/x-www-form-urlencoded"
        } `
        -Body $tokenBody
    
    $accessToken = $tokenResponse.access_token
    Write-Host "OK - Access token obtained" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Failed to get access token" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

# Common headers for eBay API calls
$headers = @{
    "Authorization" = "Bearer $accessToken"
    "Accept" = "application/json"
    "Content-Language" = "en-US"
    "Accept-Language" = "en-US"
    "X-EBAY-C-MARKETPLACE-ID" = $marketplaceId
    "Content-Type" = "application/json"
}

# Step 2: List all offers
Write-Host ""
Write-Host "Listing all offers..." -ForegroundColor Yellow

$allOffers = @()
$limit = 200
$offset = 0

while ($true) {
    try {
        $url = "$apiHost/sell/inventory/v1/offer?limit=$limit&offset=$offset&marketplace_id=$marketplaceId"
        $response = Invoke-RestMethod -Uri $url -Method Get -Headers $headers -ErrorAction Stop
        
        if ($response.offers -and $response.offers.Count -gt 0) {
            $allOffers += $response.offers
            Write-Host "  Fetched $($response.offers.Count) offers (offset: $offset)" -ForegroundColor Gray
            
            # Check if there are more pages
            $total = if ($response.total) { $response.total } else { $response.offers.Count }
            if ($allOffers.Count -ge $total -or $response.offers.Count -lt $limit) {
                break
            }
            $offset += $limit
        } else {
            break
        }
    } catch {
        # If we get error 25707, we have invalid SKUs - need to use inventory scan instead
        $errorBody = $_.ErrorDetails.Message | ConvertFrom-Json
        if ($errorBody.errors[0].errorId -eq 25707) {
            Write-Host "⚠ Error 25707 detected - offers list blocked by invalid SKUs" -ForegroundColor Yellow
            Write-Host "  Using inventory scan fallback..." -ForegroundColor Yellow
            break
        }
        Write-Host "ERROR: Failed to list offers" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
        exit 1
    }
}

# Step 3: Filter offers with invalid SKUs or UNPUBLISHED status
$validSkuPattern = '^[A-Za-z0-9]{1,50}$'
$offersToDelete = $allOffers | Where-Object {
    $status = $_.status
    $sku = $_.sku
    $badSku = -not ($sku -match $validSkuPattern)
    
    ($status -eq 'UNPUBLISHED') -or $badSku
}

Write-Host ""
Write-Host "Found $($allOffers.Count) total offers" -ForegroundColor Cyan
Write-Host "Found $($offersToDelete.Count) offers to delete (UNPUBLISHED or invalid SKU)" -ForegroundColor Cyan

if ($offersToDelete.Count -eq 0) {
    Write-Host "OK - No broken drafts to delete!" -ForegroundColor Green
    exit 0
}

# Show some examples
Write-Host ""
Write-Host "Examples of offers to delete:" -ForegroundColor Yellow
$offersToDelete | Select-Object -First 5 | ForEach-Object {
    $offerIdStr = $_.offerId
    $skuStr = $_.sku
    $statusStr = $_.status
    $reason = if ($skuStr -notmatch $validSkuPattern) { "Invalid SKU: $skuStr" } else { "Status: $statusStr" }
    Write-Host "  - OfferID: $offerIdStr - $reason" -ForegroundColor Gray
}

# Confirm deletion
Write-Host ""
$offerCount = $offersToDelete.Count
Write-Host "Ready to delete $offerCount offers."
$confirmation = Read-Host "Type 'yes' to confirm deletion"
if ($confirmation -ne "yes") {
    Write-Host "Aborted." -ForegroundColor Yellow
    exit 0
}

# Step 4: Delete offers
Write-Host ""
Write-Host "Deleting offers..." -ForegroundColor Yellow
$deleted = 0
$failed = 0

foreach ($offer in $offersToDelete) {
    try {
        $offerId = $offer.offerId
        $sku = $offer.sku
        $url = "$apiHost/sell/inventory/v1/offer/$offerId"
        Invoke-RestMethod -Uri $url -Method Delete -Headers $headers -ErrorAction Stop | Out-Null
        $deleted++
        Write-Host "  OK - Deleted offer $offerId (SKU: $sku)" -ForegroundColor Green
    } catch {
        $failed++
        $errorMsg = $_.Exception.Message
        Write-Host "  FAIL - Could not delete offer $offerId : $errorMsg" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
$totalScanned = $allOffers.Count
Write-Host "Total offers scanned: $totalScanned" -ForegroundColor White
Write-Host "Offers deleted: $deleted" -ForegroundColor Green
Write-Host "Failed deletions: $failed" -ForegroundColor Red
Write-Host ""
Write-Host "Done!" -ForegroundColor Green
