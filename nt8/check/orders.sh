#!/bin/sh
# Build and run the order-gate harness (needs mono-mcs and mono). Every refused order must never reach
# the stand-in account; brackets must follow fills. Then the PIN on ChartBridge's own page (check/PinHarness.cs)
# the seam between backfill and live trades (check/SeamHarness.cs), the side of every trade (check/SidesHarness.cs),
# the session tables and the served window (check/WindowHarness.cs, 0.3.5), the daily bars (check/BarsHarness.cs, 0.3.6) and the
# 0.3.7 data side: settlement, higher-timeframe bars, the weekly profile, the gate's stop edges and CME holidays (check/DataHarness.cs).
# 0.4.0: quote-only markets, their rolls and settlement times, the tape counters, error lines and /diag health (check/MarketsHarness.cs).
# 0.4.0: accounts, the per-account checkmark, Gone, Archive and cancel from the Working orders tab (check/AccountsHarness.cs).
# The build goes to $CHARTBRIDGE_ORDERS_EXE (default /tmp/chartbridge-orders.exe): set it to a private path so parallel runs cannot overwrite each other's build.
cd "$(dirname "$0")/.." && mcs -langversion:5 -nowarn:67,169,219,414 -r:System.dll -r:System.Core.dll -out:"${CHARTBRIDGE_ORDERS_EXE:-/tmp/chartbridge-orders.exe}" \
  ChartBridge.cs ChartBridgeOrders.cs ChartBridgePin.cs ChartBridgeBars.cs ChartBridgeTape.cs ChartBridgeV3.cs ChartBridgeAccounts.cs check/Nt8Stubs.cs check/OrdersHarness.cs check/PinHarness.cs check/SeamHarness.cs check/SidesHarness.cs check/WindowHarness.cs check/BarsHarness.cs check/DataHarness.cs check/MarketsHarness.cs check/AccountsHarness.cs && mono "${CHARTBRIDGE_ORDERS_EXE:-/tmp/chartbridge-orders.exe}"
