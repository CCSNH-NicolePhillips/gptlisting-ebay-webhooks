# Load prod.env and run test
Get-Content prod.env | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') {
        Set-Item -Path "env:$($matches[1])" -Value $matches[2]
    }
}

node scripts/test-zero-in.mjs
