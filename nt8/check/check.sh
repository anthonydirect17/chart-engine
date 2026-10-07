#!/bin/sh
# Compile-check ChartBridge.cs, ChartBridgeOrders.cs, ChartBridgePin.cs, ChartBridgeBars.cs, ChartBridgeTape.cs, ChartBridgeV3.cs, ChartBridgeAccounts.cs and ChartBridgeMerge.cs (0.4.0) as C# 5 against stand-in NinjaTrader types (Linux, needs mono-mcs).
# Catches syntax and .NET mistakes; the real test is compiling inside NinjaTrader.
# The build goes to $CHARTBRIDGE_CHECK_DLL (default /tmp/chartbridge-check.dll): set it to a private path so parallel runs cannot overwrite each other's build.
cd "$(dirname "$0")/.." && mcs -langversion:5 -target:library -nowarn:67,169,219,414 -r:System.dll -r:System.Core.dll -out:"${CHARTBRIDGE_CHECK_DLL:-/tmp/chartbridge-check.dll}" ChartBridge.cs ChartBridgeOrders.cs ChartBridgePin.cs ChartBridgeBars.cs ChartBridgeTape.cs ChartBridgeV3.cs ChartBridgeAccounts.cs ChartBridgeMerge.cs check/Nt8Stubs.cs
