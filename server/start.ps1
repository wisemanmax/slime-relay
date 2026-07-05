# Loads .env and starts the extractor. Windows (PowerShell).
Set-Location $PSScriptRoot
if (Test-Path .env) {
  Get-Content .env | Where-Object { $_ -and ($_ -notmatch '^\s*#') -and ($_ -match '=') } | ForEach-Object {
    $parts = $_ -split '=', 2
    $key = $parts[0].Trim()
    $val = $parts[1].Trim()
    [Environment]::SetEnvironmentVariable($key, $val, 'Process')
  }
}
node server.js
