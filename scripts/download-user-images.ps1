# Download all images for a specific user from R2/S3 storage
# Uses the admin API endpoint instead of AWS CLI

param(
    [Parameter(Mandatory=$true)]
    [string]$UserId = "google-oauth2|115560755337742366394",
    
    [int]$HoursBack = 12,
    
    [string]$OutDir = "C:\temp\user-images",
    
    [string]$ApiUrl = "https://draftpilot.app/.netlify/functions/admin-list-user-images"
)

# Create output directory
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "Fetching image list for user: $UserId" -ForegroundColor Cyan

try {
    # Call admin API to get list of images
    $response = Invoke-RestMethod -Uri "$ApiUrl`?userId=$UserId" -Method Get
    
    if (-not $response.ok) {
        Write-Host "Error: $($response.error)" -ForegroundColor Red
        return
    }
    
    $images = $response.images
    
    if ($images.Count -eq 0) {
        Write-Host "No images found for user $UserId" -ForegroundColor Yellow
        return
    }
    
    # Filter by time if specified
    if ($HoursBack -gt 0) {
        $since = (Get-Date).ToUniversalTime().AddHours(-$HoursBack)
        $images = $images | Where-Object {
            $lastModified = [datetime]::Parse($_.lastModified)
            $lastModified -ge $since
        }
        
        if ($images.Count -eq 0) {
            Write-Host "No images modified in the last $HoursBack hours" -ForegroundColor Yellow
            return
        }
    }
    
    Write-Host "Found $($images.Count) images. Downloading..." -ForegroundColor Green
    
    $downloaded = 0
    $failed = 0
    
    foreach ($img in $images) {
        try {
            $filename = $img.filename
            $url = $img.url
            $outPath = Join-Path $OutDir $filename
            
            Write-Host "  [$($downloaded + 1)/$($images.Count)] Downloading $filename..." -NoNewline
            
            Invoke-WebRequest -Uri $url -OutFile $outPath -UseBasicParsing
            
            Write-Host " OK" -ForegroundColor Green
            $downloaded++
            
        } catch {
            Write-Host " FAILED: $($_.Exception.Message)" -ForegroundColor Red
            $failed++
        }
    }
    
    Write-Host "`nDownload complete!" -ForegroundColor Cyan
    Write-Host "  Downloaded: $downloaded files" -ForegroundColor Green
    if ($failed -gt 0) {
        Write-Host "  Failed: $failed files" -ForegroundColor Red
    }
    Write-Host "  Location: $OutDir" -ForegroundColor Cyan
    
    # Create zip file
    if ($downloaded -gt 0) {
        $zipPath = "$OutDir-$(Get-Date -Format 'yyyyMMdd-HHmmss').zip"
        Write-Host "`nCreating zip archive..." -ForegroundColor Cyan
        Compress-Archive -Path (Join-Path $OutDir '*') -DestinationPath $zipPath -Force
        Write-Host "Zip created: $zipPath" -ForegroundColor Green
    }
    
} catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
}
