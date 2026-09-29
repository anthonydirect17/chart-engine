#!/bin/sh
# Build and run the order-gate harness (needs mono-mcs and mono). Every refused order must never reach
# the stand-in account; brackets must follow fills.
cd "$(dirname "$0")/.." && mcs -langversion:5 -nowarn:67,169,219,414 -r:System.dll -r:System.Core.dll -out:/tmp/chartbridge-orders.exe \
  ChartBridge.cs ChartBridgeOrders.cs check/Nt8Stubs.cs check/OrdersHarness.cs && mono /tmp/chartbridge-orders.exe
