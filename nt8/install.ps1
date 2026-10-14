# Installs (or updates) ChartBridge and the live chart page into NinjaTrader 8.
# Run from the chart-engine folder:   powershell -ExecutionPolicy Bypass -File nt8\install.ps1
# Then open NinjaTrader > New > NinjaScript Editor and compile (F5). Browse to http://localhost:8765/

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$docs = [Environment]::GetFolderPath('MyDocuments')
$nt = Join-Path $docs 'NinjaTrader 8'
if (-not (Test-Path $nt)) { throw "NinjaTrader 8 folder not found at $nt" }

$addons = Join-Path $nt 'bin\Custom\AddOns'
$www = Join-Path $nt 'ChartBridge\www'
New-Item -ItemType Directory -Force -Path $addons, $www | Out-Null

# What gets copied is listed once, in nt8\install-files.json (nt8\update-pc.ps1 reads the same list):
# the add-on sources (every ChartBridge*.cs file; order entry stays off unless config.txt turns it on) and the
# live page files.
$list = Get-Content -Raw -LiteralPath (Join-Path $repo 'nt8\install-files.json') | ConvertFrom-Json
foreach ($f in $list.addons) {
  Copy-Item (Join-Path $repo $f) (Join-Path $addons (Split-Path -Leaf $f)) -Force
}
foreach ($f in $list.www) {
  $dest = Join-Path $www $f.to
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
  Copy-Item (Join-Path $repo $f.from) $dest -Force
}

Write-Host "$(($list.addons | ForEach-Object { Split-Path -Leaf $_ }) -join ', ') -> $addons"
Write-Host "live page       -> $www"
Write-Host ""
Write-Host "Next: NinjaTrader > New > NinjaScript Editor > compile (F5)."
Write-Host "Then open http://localhost:8765/ in Chrome or Edge right away and set this PC's 4-digit PIN (whoever opens it first sets it)."
Write-Host "Messages appear in New > NinjaScript Output."
Write-Host "Forgot the PIN? Delete ChartBridge\pin.txt in the NinjaTrader 8 folder (NinjaTrader may stay open); the page asks for a new one."
Write-Host "ChartBridge answers this PC only. Other pages that may read the stream (The Desk) go in allowOrigins in config.txt;"
Write-Host "keep inbound port 8765 blocked in the Windows firewall as a second layer (see nt8\PROTOCOL.md, Network access)."
Write-Host "To keep this PC up to date from now on: README.md, 'Keep this PC up to date' (nt8\update-pc.ps1)."
