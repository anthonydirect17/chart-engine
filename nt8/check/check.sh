#!/bin/sh
# Compile-check ChartBridge.cs, ChartBridgeOrders.cs, ChartBridgePin.cs, ChartBridgeBars.cs, ChartBridgeTape.cs and ChartBridgeAccounts.cs (0.4.0) as C# 5 against stand-in NinjaTrader types (Linux, needs mono-mcs).
# Catches syntax and .NET mistakes; the real test is compiling inside NinjaTrader.
cd "$(dirname "$0")/.." && mcs -langversion:5 -target:library -nowarn:67,169,219,414 -r:System.dll -r:System.Core.dll -out:/tmp/chartbridge-check.dll ChartBridge.cs ChartBridgeOrders.cs ChartBridgePin.cs ChartBridgeBars.cs ChartBridgeTape.cs ChartBridgeAccounts.cs check/Nt8Stubs.cs
