#!/bin/sh
# Build and run the order-gate harness (needs mono-mcs and mono). Every refused order must never reach
# the stand-in account; brackets must follow fills. Then the PIN on ChartBridge's own page (check/PinHarness.cs)
# the seam between backfill and live trades (check/SeamHarness.cs), the side of every trade (check/SidesHarness.cs),
# the session tables and the served window (check/WindowHarness.cs, 0.3.5), the daily bars (check/BarsHarness.cs, 0.3.6) and the
# 0.3.7 data side: settlement, higher-timeframe bars, the weekly profile, the gate's stop edges and CME holidays (check/DataHarness.cs).
# 0.4.0: quote-only markets, their rolls and settlement times, the tape counters, error lines and /diag health (check/MarketsHarness.cs).
# 0.4.0 B1: stop-limit and MIT entries, Order Strategies, breakeven and trailing, managed.txt and the restart (check/StrategiesHarness.cs).
cd "$(dirname "$0")/.." && mcs -langversion:5 -nowarn:67,169,219,414 -r:System.dll -r:System.Core.dll -out:/tmp/chartbridge-orders.exe \
  ChartBridge.cs ChartBridgeOrders.cs ChartBridgePin.cs ChartBridgeBars.cs ChartBridgeTape.cs ChartBridgeStrategies.cs check/Nt8Stubs.cs check/OrdersHarness.cs check/PinHarness.cs check/SeamHarness.cs check/SidesHarness.cs check/WindowHarness.cs check/BarsHarness.cs check/DataHarness.cs check/MarketsHarness.cs check/StrategiesHarness.cs && mono /tmp/chartbridge-orders.exe
