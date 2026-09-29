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
New-Item -ItemType Directory -Force -Path $addons, $www, (Join-Path $www 'src') | Out-Null

Copy-Item (Join-Path $repo 'nt8\ChartBridge.cs') (Join-Path $addons 'ChartBridge.cs') -Force
Copy-Item (Join-Path $repo 'nt8\ChartBridgeOrders.cs') (Join-Path $addons 'ChartBridgeOrders.cs') -Force   # order entry (off unless config.txt turns it on)
Copy-Item (Join-Path $repo 'live\index.html') (Join-Path $www 'index.html') -Force
Copy-Item (Join-Path $repo 'live\live.js') (Join-Path $www 'live.js') -Force
Copy-Item (Join-Path $repo 'live\live.css') (Join-Path $www 'live.css') -Force
Copy-Item (Join-Path $repo 'live\bar-builder.js') (Join-Path $www 'bar-builder.js') -Force
Copy-Item (Join-Path $repo 'live\order-ticket.js') (Join-Path $www 'order-ticket.js') -Force
Copy-Item (Join-Path $repo 'src\chart-engine.js') (Join-Path $www 'src\chart-engine.js') -Force

Write-Host "ChartBridge.cs, ChartBridgeOrders.cs -> $addons"
Write-Host "live page       -> $www"
Write-Host ""
Write-Host "Next: NinjaTrader > New > NinjaScript Editor > compile (F5)."
Write-Host "Then open http://localhost:8765/ in Chrome or Edge. Messages appear in New > NinjaScript Output."
