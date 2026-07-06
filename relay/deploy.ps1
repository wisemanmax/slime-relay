# One-shot relay deploy (Windows). Usage:  ./deploy.ps1 [TOKEN]
param([string]$Token)
Set-Location $PSScriptRoot

if (-not $Token) { $Token = Read-Host "Shared token (RELAY_TOKEN — same as your app's SLIME_TOKEN)" }
if (-not $Token) { Write-Error "A token is required."; exit 1 }

Write-Host "-> Installing wrangler..."
npm install --silent

Write-Host "-> Logging in to Cloudflare (a browser window will open)..."
npx wrangler login

if (Select-String -Path wrangler.toml -Pattern "PASTE_KV_NAMESPACE_ID_HERE" -Quiet) {
  Write-Host "-> Creating KV namespace SERVERS..."
  $out = npx wrangler kv namespace create SERVERS 2>&1 | Tee-Object -Variable dummy | Out-String
  $id = [regex]::Match($out, '[0-9a-fA-F]{32}').Value
  if (-not $id) { Write-Error "Couldn't read the KV id — paste it into wrangler.toml manually."; exit 1 }
  (Get-Content wrangler.toml) -replace 'PASTE_KV_NAMESPACE_ID_HERE', $id | Set-Content wrangler.toml
  Write-Host "-> KV id wired in: $id"
}

Write-Host "-> Setting RELAY_TOKEN secret..."
$Token | npx wrangler secret put RELAY_TOKEN

Write-Host "-> Deploying..."
npx wrangler deploy

Write-Host "`n Relay deployed. Dashboard: <the workers.dev URL above>/?key=$Token"
