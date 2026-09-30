#!/bin/sh
# Build and run the order-gate harness (needs mono-mcs and mono). Every refused order must never reach
# the stand-in account; brackets must follow fills. Then the PIN on ChartBridge's own page (check/PinHarness.cs)
# the seam between backfill and live trades (check/SeamHarness.cs), the side of every trade (check/SidesHarness.cs) and
# live first, the recent trades first and the older history after (check/FillHarness.cs).
cd "$(dirname "$0")/.." && mcs -langversion:5 -nowarn:67,169,219,414 -r:System.dll -r:System.Core.dll -out:/tmp/chartbridge-orders.exe \
  ChartBridge.cs ChartBridgeOrders.cs ChartBridgePin.cs check/Nt8Stubs.cs check/OrdersHarness.cs check/PinHarness.cs check/SeamHarness.cs check/SidesHarness.cs check/FillHarness.cs && mono /tmp/chartbridge-orders.exe
