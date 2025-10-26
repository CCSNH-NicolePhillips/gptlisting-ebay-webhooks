#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://localhost:8888}"

echo "[1] Analyze (fg, small)"
curl -s -X POST "$BASE/.netlify/functions/analyze-images" \
  -H "Content-Type: application/json" \
  -d '{"images":["https://dummyimage.com/600x400/000/fff.jpg"],"batchSize":12}' | jq .

echo "[2] BG job"
JOB=$(curl -s -X POST "$BASE/.netlify/functions/analyze-images-bg" \
  -H "Content-Type: application/json" \
  -d '{"images":["https://dummyimage.com/600x400/000/fff.jpg","https://dummyimage.com/600x400/222/fff.jpg"],"batchSize":12}' | jq -r .jobId)
echo "job=$JOB"

echo "[3] Poll"
for i in $(seq 1 10); do
  R=$(curl -s "$BASE/.netlify/functions/analyze-images-status?jobId=$JOB")
  echo "$R" | jq .state
  STATE=$(echo "$R" | jq -r .state)
  if [ "$STATE" = "complete" ] || [ "$STATE" = "error" ]; then
    echo "$R" | jq .
    break
  fi
  sleep 2
done

echo "[4] Create draft (dry-run)"
GROUPS=$(echo "$R" | jq '.groups | map(select(.pricing and .pricing.ebay)) | .[:1]')
curl -s -X POST "$BASE/.netlify/functions/create-ebay-draft" \
  -H "Content-Type: application/json" \
  -d "{\"items\":$GROUPS}" | jq .
