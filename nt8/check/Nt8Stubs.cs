// Compile-check stand-ins for the NinjaTrader 8 types ChartBridge uses. NOT the real API:
// they let `mcs -langversion:5` catch syntax and .NET mistakes on Linux. The real test is
// compiling in NinjaTrader's NinjaScript Editor.
using System;
using System.Collections.Generic;

namespace NinjaTrader.NinjaScript
{
    public enum State { SetDefaults, Configure, Active, DataLoaded, Historical, Transition, Realtime, Terminated }
    public enum PrintTo { OutputTab1, OutputTab2 }
    public abstract class NinjaScriptBase
    {
        public string Name { get; set; }
        public string Description { get; set; }
        public State State { get; set; }
        protected virtual void OnStateChange() { }
    }
    public abstract class AddOnBase : NinjaScriptBase { }
}
namespace NinjaTrader.Code { public static class Output { public static void Process(string s, NinjaTrader.NinjaScript.PrintTo t) { Console.WriteLine(s); } } }
namespace NinjaTrader.Core
{
    public class GeneralOptionsClass { public TimeZoneInfo TimeZoneInfo { get { return TimeZoneInfo.Local; } } }
    public static class Globals
    {
        public static string UserDataDir { get { return "/tmp/nt8/"; } }
        public static GeneralOptionsClass GeneralOptions = new GeneralOptionsClass();
    }
}
namespace NinjaTrader.Cbi
{
    public enum ErrorCode { NoError, UserAbort, Panic }
    public enum MarketPosition { Flat, Long, Short }
    public class MasterInstrument
    {
        public string Name { get; set; }
        public double TickSize { get; set; }
        public double PointValue { get; set; }
        public NinjaTrader.Data.TradingHours TradingHours { get; set; }
    }
    public class Instrument
    {
        public string FullName { get; set; }
        public MasterInstrument MasterInstrument { get; set; }
        public static Instrument GetInstrument(string name) { return null; }
    }
    public class Execution
    {
        public Instrument Instrument { get; set; }
        public MarketPosition MarketPosition { get; set; }
        public int Quantity { get; set; }
        public double Price { get; set; }
        public DateTime Time { get; set; }
        public string ExecutionId { get; set; }
        public string OrderId { get; set; }
    }
    // NinjaTrader's ExecutionEventArgs has NO Instrument property (confirmed by the NT8 compiler, 2026-09-29).
    public class ExecutionEventArgs : EventArgs
    {
        public Execution Execution { get; set; }
        public MarketPosition MarketPosition { get; set; }
        public int Quantity { get; set; }
        public double Price { get; set; }
        public DateTime Time { get; set; }
        public string ExecutionId { get; set; }
        public string OrderId { get; set; }
    }
    public enum ConnectionStatus { Connected, Connecting, ConnectionLost, Disconnected, Disconnecting }
    public class Connection { public ConnectionStatus Status { get; set; } }
    public class Order { }
    public class Position { }
    public class OrderEventArgs : EventArgs { public Order Order { get; set; } }
    public class PositionEventArgs : EventArgs { public Position Position { get; set; } }
    public class Account
    {
        public static List<Account> All = new List<Account>();
        public string Name { get; set; }
        public Connection Connection { get; set; }
        public List<Execution> Executions = new List<Execution>();
        public List<Order> Orders = new List<Order>();
        public List<Position> Positions = new List<Position>();
        public event EventHandler<ExecutionEventArgs> ExecutionUpdate;
        public event EventHandler<OrderEventArgs> OrderUpdate;
        public event EventHandler<PositionEventArgs> PositionUpdate;
        public void Fire(ExecutionEventArgs e) { if (ExecutionUpdate != null) ExecutionUpdate(this, e); }
    }
}
namespace NinjaTrader.Data
{
    public enum MarketDataType { Ask, Bid, Last, DailyHigh, DailyLow, DailyVolume, LastClose, Opening, OpenInterest, Settlement, Unknown }
    public enum BarsPeriodType { Tick, Volume, Range, Second, Minute, Day, Week, Month, Year }
    public class TradingHours { }
    public class BarsPeriod { public BarsPeriodType BarsPeriodType { get; set; } public int Value { get; set; } }
    public class Bars
    {
        public int Count { get { return 0; } }
        public DateTime GetTime(int i) { return DateTime.Now; }
        public double GetOpen(int i) { return 0; }
        public double GetHigh(int i) { return 0; }
        public double GetLow(int i) { return 0; }
        public double GetClose(int i) { return 0; }
        public long GetVolume(int i) { return 0; }
    }
    public class BarsRequest : IDisposable
    {
        public BarsRequest(NinjaTrader.Cbi.Instrument i, DateTime from, DateTime to) { }
        public BarsPeriod BarsPeriod { get; set; }
        public TradingHours TradingHours { get; set; }
        public Bars Bars { get; set; }
        public void Request(Action<BarsRequest, NinjaTrader.Cbi.ErrorCode, string> callback) { }
        public void Dispose() { }
    }
    public class MarketDataEventArgs : EventArgs
    {
        public NinjaTrader.Cbi.Instrument Instrument { get; set; }
        public MarketDataType MarketDataType { get; set; }
        public double Price { get; set; }
        public long Volume { get; set; }
        public DateTime Time { get; set; }
    }
    public class MarketData
    {
        public MarketData(NinjaTrader.Cbi.Instrument i) { }
        public event EventHandler<MarketDataEventArgs> Update;
    }
}
