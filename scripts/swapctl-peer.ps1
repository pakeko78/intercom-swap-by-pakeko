Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

if ($args.Length -lt 3) {
  throw "Usage: scripts\\swapctl-peer.ps1 <storeName> <scBridgePort> <swapctl args...>`nExample: scripts\\swapctl-peer.ps1 swap-maker 49222 info"
}

$storeName = [string]$args[0]
$scPort = [string]$args[1]
$rest = $args[2..($args.Length - 1)]

$tokenFile = Join-Path $root ("onchain/sc-bridge/{0}.token" -f $storeName)
if (-not (Test-Path -Path $tokenFile)) {
  throw "Missing SC-Bridge token file: $tokenFile`nHint: start the peer once so it generates a token (see scripts\\run-swap-*.ps1)."
}

$scToken = (Get-Content -Raw -Path $tokenFile).Trim()

$keypairFile = Join-Path $root ("stores/{0}/db/keypair.json" -f $storeName)
if (Test-Path -Path $keypairFile) {
  node scripts/swapctl.mjs --url ("ws://127.0.0.1:{0}" -f $scPort) --token $scToken --peer-keypair $keypairFile @rest
  exit $LASTEXITCODE
}

node scripts/swapctl.mjs --url ("ws://127.0.0.1:{0}" -f $scPort) --token $scToken @rest
