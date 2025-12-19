# Fix all test file type errors with proper assertions

# Fix policy-defaults.test.ts
$file1 = 'tests/functions/policy-defaults.test.ts'
$content1 = Get-Content $file1 -Raw

# Replace pattern: after handler call, assert type
$pattern1 = '(const response = await handler\(event as HandlerEvent, \{\} as any\);)\s+if \(\!response\) throw new Error\(''No response''\);'
$replacement1 = '$1' + "`n`t`t`tif (!response) throw new Error('No response');`n`t`t`tconst typedResponse = response as import('@netlify/functions').HandlerResponse;"

$content1 = $content1 -replace $pattern1, $replacement1

# Also fix cases without the null check already
$pattern2 = '(const response = await handler\(event as HandlerEvent, \{\} as any\);)(\s+)(expect\(response)'
$replacement2 = '$1' + "`n`t`t`tif (!response) throw new Error('No response');`n`t`t`tconst typedResponse = response as import('@netlify/functions').HandlerResponse;`n$2expect(typedResponse"

$content1 = $content1 -replace $pattern2, $replacement2

# Replace all response. with typedResponse.
$content1 = $content1 -replace 'expect\(response\.statusCode\)', 'expect(typedResponse.statusCode)'
$content1 = $content1 -replace 'expect\(response\.body\)', 'expect(typedResponse.body)'
$content1 = $content1 -replace 'JSON\.parse\(response\.body\)', 'JSON.parse(typedResponse.body)'
$content1 = $content1 -replace 'const body = JSON\.parse\(response\.body\)', 'const body = JSON.parse(typedResponse.body)'

Set-Content $file1 -Value $content1 -NoNewline

# Fix user-settings-persistence.test.ts
$file2 = 'tests/functions/user-settings-persistence.test.ts'
$content2 = Get-Content $file2 -Raw

# Same replacements
$content2 = $content2 -replace $pattern1, $replacement1
$content2 = $content2 -replace $pattern2, $replacement2
$content2 = $content2 -replace 'expect\(response\.statusCode\)', 'expect(typedResponse.statusCode)'
$content2 = $content2 -replace 'expect\(response\.body\)', 'expect(typedResponse.body)'
$content2 = $content2 -replace 'JSON\.parse\(response\.body\)', 'JSON.parse(typedResponse.body)'
$content2 = $content2 -replace 'const body = JSON\.parse\(response\.body\)', 'const body = JSON.parse(typedResponse.body)'
$content2 = $content2 -replace 'const data = JSON\.parse\(response\.body\)', 'const data = JSON.parse(typedResponse.body)'

Set-Content $file2 -Value $content2 -NoNewline

Write-Host "Fixed test type errors"
