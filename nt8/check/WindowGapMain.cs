// Runs nt8/check/WindowGapHarness.cs on its own (reproduce-first: built once against the 0.6.7 sources, once against the
// current ones). Not part of orders.sh, which runs WindowGapHarness inside its own Main.
//   mcs -langversion:5 -nowarn:67,169,219,414 -r:System.dll -r:System.Core.dll -out:wgap.exe ChartBridge*.cs check/Nt8Stubs.cs \
//       check/WindowGapHarness.cs check/WindowGapMain.cs && mono wgap.exe
using System;
using System.IO;

public static class WindowGapMain
{
    public static int Main()
    {
        string home = Path.Combine(Path.GetTempPath(), "cb-wgap-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(home, "ChartBridge"));
        NinjaTrader.Core.Globals.UserDataDir = home;
        int fails = 0, checks = 0;
        WindowGapHarness.Run((ok, what) => { checks++; if (!ok) fails++; Console.WriteLine((ok ? "ok   " : "FAIL ") + what); });
        Console.WriteLine(checks + " checks, " + fails + " failed");
        return fails == 0 ? 0 : 1;
    }
}
