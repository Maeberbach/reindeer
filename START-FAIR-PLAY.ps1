# Start Reindeer: Fair Play
# Double-click this (or right-click → Run with PowerShell)

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location "$appDir\apps\reindeer-fair-play"

# Check Node is available
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "  Node.js is not installed." -ForegroundColor Red
    Write-Host "  Run INSTALL.ps1 first." -ForegroundColor Red
    Read-Host "  Press Enter to close"
    exit 1
}

Write-Host ""
Write-Host "  Starting Reindeer: Fair Play..." -ForegroundColor Green
Write-Host "  Your browser will open automatically." -ForegroundColor Green
Write-Host "  Keep this window open while using the app." -ForegroundColor Yellow
Write-Host "  Close this window to stop the app." -ForegroundColor Yellow
Write-Host ""

# Open browser after 3 seconds
Start-Job -ScriptBlock {
    Start-Sleep -Seconds 4
    Start-Process "http://localhost:5000"
} | Out-Null

# Start the server
npx tsx server/index.ts
