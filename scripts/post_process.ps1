# POST to local /process to create a draft from Dropbox images
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/post_process.ps1

$body = @{ mode = 'draft'; folderPath = '/EBAY' } | ConvertTo-Json

try {
    $r = Invoke-WebRequest -Uri 'http://localhost:3000/process?limit=1' -Method Post -ContentType 'application/json' -Body $body -UseBasicParsing
    Write-Output "STATUS:$($r.StatusCode)"
    Write-Output $r.Content
} catch {
    $errResp = $_.Exception.Response
    if ($errResp -ne $null) {
        $sr = New-Object System.IO.StreamReader($errResp.GetResponseStream())
        Write-Output "ERROR_STATUS:$($errResp.StatusCode)"
        Write-Output $sr.ReadToEnd()
    } else {
        Write-Output $_.Exception.Message
    }
}
