$BASE = $env:BASE; if (-not $BASE) { $BASE = "http://localhost:8888" }

Write-Host "[1] Analyze (fg, small)"
$resp = Invoke-RestMethod -Method Post -Uri "$BASE/.netlify/functions/analyze-images" -ContentType "application/json" -Body '{"images":["https://dummyimage.com/600x400/000/fff.jpg"],"batchSize":12}'
$resp | ConvertTo-Json -Depth 6

Write-Host "[2] BG job"
$job = Invoke-RestMethod -Method Post -Uri "$BASE/.netlify/functions/analyze-images-bg" -ContentType "application/json" -Body '{"images":["https://dummyimage.com/600x400/000/fff.jpg","https://dummyimage.com/600x400/222/fff.jpg"],"batchSize":12}'
$job

Write-Host "[3] Poll"
for ($i=0; $i -lt 10; $i++) {
  $st = Invoke-RestMethod -Uri "$BASE/.netlify/functions/analyze-images-status?jobId=$($job.jobId)"
  $st.state
  if ($st.state -eq "complete" -or $st.state -eq "error") { $st | ConvertTo-Json -Depth 6; break }
  Start-Sleep -Seconds 2
}

Write-Host "[4] Create draft (dry-run)"
$groups = $st.groups | Where-Object { $_.pricing -and $_.pricing.ebay } | Select-Object -First 1
Invoke-RestMethod -Method Post -Uri "$BASE/.netlify/functions/create-ebay-draft" -ContentType "application/json" -Body (@{ items = @($groups) } | ConvertTo-Json -Depth 6) | ConvertTo-Json -Depth 6
