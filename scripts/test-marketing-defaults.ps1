# Test marketing defaults endpoints
# Requires auth token from browser localStorage

param(
    [Parameter(Mandatory=$false)]
    [string]$token
)

if (-not $token) {
    Write-Host "Enter your auth token (from browser localStorage 'auth_token'):" -ForegroundColor Yellow
    $token = Read-Host
}

if (-not $token) {
    Write-Host "Error: Token is required" -ForegroundColor Red
    exit 1
}

$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
}

$baseUrl = "https://draftpilot-ai.netlify.app/.netlify/functions"

Write-Host "`n=== Testing Marketing Defaults Endpoints ===" -ForegroundColor Cyan

# Test 1: Get defaults (should be null initially)
Write-Host "`n1. GET ebay-get-marketing-defaults" -ForegroundColor Yellow
try {
    $result = Invoke-RestMethod -Uri "$baseUrl/ebay-get-marketing-defaults" -Headers $headers
    Write-Host "✓ Success:" -ForegroundColor Green
    Write-Host ($result | ConvertTo-Json -Depth 5)
} catch {
    Write-Host "✗ Failed:" -ForegroundColor Red
    Write-Host $_.Exception.Message
}

# Test 2: Set default campaign
Write-Host "`n2. POST ebay-set-marketing-default (setting to 151310691012)" -ForegroundColor Yellow
try {
    $body = @{ defaultPromoCampaignId = "151310691012" } | ConvertTo-Json
    $result = Invoke-RestMethod -Uri "$baseUrl/ebay-set-marketing-default" -Method POST -Headers $headers -Body $body
    Write-Host "✓ Success:" -ForegroundColor Green
    Write-Host ($result | ConvertTo-Json -Depth 5)
} catch {
    Write-Host "✗ Failed:" -ForegroundColor Red
    Write-Host $_.Exception.Message
}

# Test 3: Get defaults again (should return 151310691012)
Write-Host "`n3. GET ebay-get-marketing-defaults (verify saved)" -ForegroundColor Yellow
try {
    $result = Invoke-RestMethod -Uri "$baseUrl/ebay-get-marketing-defaults" -Headers $headers
    Write-Host "✓ Success:" -ForegroundColor Green
    Write-Host ($result | ConvertTo-Json -Depth 5)
    
    if ($result.defaults.defaultPromoCampaignId -eq "151310691012") {
        Write-Host "  ✓ Default campaign ID matches!" -ForegroundColor Green
    } else {
        Write-Host "  ✗ Default campaign ID mismatch!" -ForegroundColor Red
    }
} catch {
    Write-Host "✗ Failed:" -ForegroundColor Red
    Write-Host $_.Exception.Message
}

# Test 4: List campaigns
Write-Host "`n4. GET ebay-list-campaigns" -ForegroundColor Yellow
try {
    $result = Invoke-RestMethod -Uri "$baseUrl/ebay-list-campaigns" -Headers $headers
    Write-Host "✓ Success:" -ForegroundColor Green
    Write-Host "  Default campaign: $($result.defaultPromoCampaignId)"
    Write-Host "  Campaigns found: $($result.campaigns.Count)"
    
    if ($result.campaigns.Count -gt 0) {
        Write-Host "`n  Campaign list:" -ForegroundColor Cyan
        foreach ($campaign in $result.campaigns) {
            Write-Host "    - ID: $($campaign.campaignId)" -ForegroundColor White
            Write-Host "      Name: $($campaign.name)"
            Write-Host "      Status: $($campaign.status)"
            Write-Host "      Funding: $($campaign.fundingStrategyType)"
            Write-Host ""
        }
    }
} catch {
    Write-Host "✗ Failed:" -ForegroundColor Red
    Write-Host $_.Exception.Message
    if ($_.ErrorDetails.Message) {
        Write-Host $_.ErrorDetails.Message
    }
}

Write-Host "`n=== Tests Complete ===" -ForegroundColor Cyan
