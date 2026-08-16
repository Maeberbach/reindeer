# Reindeer Legacy - Windows Installer
# Right-click this file → "Run with PowerShell"
# This installs everything needed and creates desktop shortcuts.

$ErrorActionPreference = "Continue"
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Green
Write-Host "        REINDEER LEGACY - INSTALLER" -ForegroundColor Green
Write-Host "  ============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  This will set up both apps on your computer."
Write-Host "  You only need to run this once."
Write-Host ""
Read-Host "  Press Enter to start, or close this window to cancel"

# ── Step 1: Check for Node.js ──
Write-Host ""
Write-Host "  [1/5] Checking for Node.js..." -ForegroundColor Cyan

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    Write-Host "  Node.js is already installed." -ForegroundColor Green
    node --version
} else {
    Write-Host "  Node.js was not found. Installing now..." -ForegroundColor Yellow
    Write-Host "  Downloading Node.js LTS..."

    $nodeUrl = "https://nodejs.org/dist/v20.17.0/node-v20.17.0-x64.msi"
    $nodeMsi = "$env:TEMP\reindeer-node-install.msi"

    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeMsi
    } catch {
        Write-Host ""
        Write-Host "  ERROR: Could not download Node.js." -ForegroundColor Red
        Write-Host "  Please download it manually from https://nodejs.org"
        Write-Host "  Install it, then run this installer again."
        Read-Host "  Press Enter to close"
        exit 1
    }

    Write-Host "  Installing Node.js (this may take a minute)..."
    Start-Process msiexec.exe -ArgumentList "/i `"$nodeMsi`" /qb" -Wait

    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")

    Remove-Item $nodeMsi -ErrorAction SilentlyContinue
    Write-Host "  Node.js installed." -ForegroundColor Green
}

# ── Step 2: Install root dependencies ──
Write-Host ""
Write-Host "  [2/5] Installing shared libraries..." -ForegroundColor Cyan
Write-Host "  This takes 1-2 minutes. Please wait..."
Write-Host ""

Set-Location $appDir
npm install 2>&1 | Select-String -NotMatch "npm warn" | ForEach-Object { Write-Host "  $_" }

# ── Step 3: Install Fair Play dependencies ──
Write-Host ""
Write-Host "  [3/5] Setting up Fair Play..." -ForegroundColor Cyan

Set-Location "$appDir\apps\reindeer-fair-play"
npm install 2>&1 | Select-String -NotMatch "npm warn" | ForEach-Object { Write-Host "  $_" }

# ── Step 4: Create desktop shortcuts ──
Write-Host ""
Write-Host "  [4/5] Creating desktop shortcuts..." -ForegroundColor Cyan

$desktop = [Environment]::GetFolderPath("Desktop")
$ws = New-Object -ComObject WScript.Shell

$shortcuts = @(
    @{ Name = "Reindeer Registry"; Target = "$appDir\START-REGISTRY.ps1" },
    @{ Name = "Reindeer Fair Play"; Target = "$appDir\START-FAIR-PLAY.ps1" },
    @{ Name = "Set OpenAI Key"; Target = "$appDir\SET-OPENAI-KEY.ps1" }
)

foreach ($s in $shortcuts) {
    $sc = $ws.CreateShortcut("$desktop\$($s.Name).lnk")
    $sc.TargetPath = "powershell.exe"
    $sc.Arguments = "-ExecutionPolicy Bypass -File `"$($s.Target)`""
    $sc.WorkingDirectory = $appDir
    $sc.Save()
    Write-Host "  Created: $($s.Name)" -ForegroundColor Green
}

# ── Step 5: Done ──
Write-Host ""
Write-Host "  [5/5] Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  ============================================" -ForegroundColor Green
Write-Host "      INSTALLATION COMPLETE!" -ForegroundColor Green
Write-Host "  ============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Three shortcuts are now on your desktop:"
Write-Host ""
Write-Host "    1. Set OpenAI Key  - double-click first, paste your key"
Write-Host "    2. Reindeer Registry  - double-click to start App 1"
Write-Host "    3. Reindeer Fair Play - double-click to start App 2"
Write-Host ""
Write-Host "  Your browser opens automatically when each app starts."
Write-Host ""
Read-Host "  Press Enter to close"
