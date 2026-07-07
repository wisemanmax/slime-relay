# One-shot relay deploy (Windows). Usage:  ./deploy.ps1 [UserToken] [AdminToken]
#   UserToken  = fleet token, same value as your app's SLIME_TOKEN (routing + heartbeat)
#   AdminToken = private admin key for the dashboard + fleet controls (auto-generated if omitted)
param([string]$UserToken, [string]$AdminToken)
Set-Location $PSScriptRoot

if (-not $UserToken) { $UserToken = Read-Host "Fleet token (USER_TOKEN - same as your app's SLIME_TOKEN)" }
if (-not $UserToken) { Write-Error "A fleet token is required."; exit 1 }
if (-not $AdminToken) {
  $bytes = New-Object 'System.Byte[]' 20
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $AdminToken = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  Write-Host "-> Generated a new ADMIN_TOKEN (save this - it's your dashboard/admin key):"
  Write-Host "      $AdminToken"
}

Write-Host "-> Installing wrangler..."
npm install --silent

Write-Host "-> Logging in to Cloudflare (a browser window will open)..."
npx wrangler login

if (Select-String -Path wrangler.toml -Pattern "PASTE_KV_NAMESPACE_ID_HERE" -Quiet) {
  Write-Host "-> Creating KV namespace SERVERS..."
  $out = npx wrangler kv namespace create SERVERS 2>&1 | Tee-Object -Variable dummy | Out-String
  $id = [regex]::Match($out, '[0-9a-fA-F]{32}').Value
  if (-not $id) { Write-Error "Couldn't read the KV id - paste it into wrangler.toml manually."; exit 1 }
  (Get-Content wrangler.toml) -replace 'PASTE_KV_NAMESPACE_ID_HERE', $id | Set-Content wrangler.toml
  Write-Host "-> KV id wired in: $id"
}

Write-Host "-> Setting USER_TOKEN secret..."
$UserToken  | npx wrangler secret put USER_TOKEN
Write-Host "-> Setting ADMIN_TOKEN secret..."
$AdminToken | npx wrangler secret put ADMIN_TOKEN

Write-Host "-> Deploying..."
npx wrangler deploy

Write-Host "`n Relay deployed. Admin dashboard: <the workers.dev URL above>/?key=$AdminToken"
