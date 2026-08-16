# Set your OpenAI API Key
# Double-click this (or right-click → Run with PowerShell)
# Paste your key (starts with sk-) and press Enter

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Green
Write-Host "        SET YOUR OPENAI API KEY" -ForegroundColor Green
Write-Host "  ============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  This key powers AI item detection in both apps."
Write-Host "  Without it, apps run in mock mode (fake detections)."
Write-Host "  Get a key at: https://platform.openai.com/api-keys"
Write-Host ""
Write-Host "  Paste your key below (it starts with sk-):"
Write-Host ""

$key = Read-Host "  OpenAI API Key"

if ($key -eq "") {
    Write-Host ""
    Write-Host "  No key entered. You can run this again later." -ForegroundColor Yellow
    Read-Host "  Press Enter to close"
    exit 0
}

# Update Registry .env
$registryEnv = "$appDir\apps\reindeer-registry\.env"
if (Test-Path $registryEnv) {
    $content = Get-Content $registryEnv
    $content = $content -replace '^OPENAI_API_KEY=.*', "OPENAI_API_KEY=$key"
    $content = $content -replace '^REINDEER_VISION_KEY=.*', "REINDEER_VISION_KEY=$key"
    $content | Set-Content $registryEnv
    Write-Host "  Registry .env updated." -ForegroundColor Green
}

# Update Fair Play .env
$fairPlayEnv = "$appDir\apps\reindeer-fair-play\.env"
if (Test-Path $fairPlayEnv) {
    $content = Get-Content $fairPlayEnv
    $content = $content -replace '^OPENAI_API_KEY=.*', "OPENAI_API_KEY=$key"
    $content | Set-Content $fairPlayEnv
    Write-Host "  Fair Play .env updated." -ForegroundColor Green
}

Write-Host ""
Write-Host "  Key saved to both apps." -ForegroundColor Green
Write-Host "  You're ready to start the apps." -ForegroundColor Green
Write-Host ""
Read-Host "  Press Enter to close"
