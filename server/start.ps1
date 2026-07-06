# Starts the SlimeWatch extractor (Windows). server.js loads .env itself.
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "X  Node.js isn't installed. Get it from https://nodejs.org (v18+), then run this again." -ForegroundColor Red
  Read-Host "Press Enter to close"
  exit 1
}

# First run? Guide the user through config instead of failing cryptically.
if (-not (Test-Path .env)) {
  Write-Host "No .env found - launching guided setup..."
  node setup.js
  if ($LASTEXITCODE -ne 0) { Read-Host "Press Enter to close"; exit 1 }
}

node server.js
# Keep the window open so a double-click user can read any error before it closes.
Write-Host ""
Read-Host "Server stopped. Press Enter to close"
