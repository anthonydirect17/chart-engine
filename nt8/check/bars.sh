#!/bin/sh
# Build and run the daily bars harness (needs mono-mcs and mono): ChartBridgeBars.cs against stand-in NinjaTrader types
# (check/BarsHarness.cs): the session date, close stamps to open times, catch-up, contracts, the message and the queue.
cd "$(dirname "$0")/.." && mcs -langversion:5 -nowarn:67,169,219,414 -r:System.dll -r:System.Core.dll -out:/tmp/chartbridge-bars.exe \
  ChartBridge.cs ChartBridgeOrders.cs ChartBridgePin.cs ChartBridgeBars.cs check/Nt8Stubs.cs check/BarsHarness.cs && mono /tmp/chartbridge-bars.exe
