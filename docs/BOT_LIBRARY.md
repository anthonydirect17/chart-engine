# Bot library file (`GET /bot-library`)

The Bot tab's Library (chart page 1.16.0) shows the frozen Bot-Lab builds on this PC. It reads them when the Bot tab
opens, from **`GET /bot-library`** on ChartBridge's own address. ChartBridge serves one local JSON file for it (lane B3
adds the endpoint; the file's place on the PC is ChartBridge's to name). The page never writes the file, never sends it
anywhere, and never takes an order or a setting from it: the library is for reading. Which build runs is the bot
program's business on this PC; ChartBridge's rails apply to every build the same way.

**No file, or a `404`:** the Library says plainly "No frozen builds on this PC" and offers nothing else. A file that is
not version 1, or not JSON, says so in one line. A single bad entry is left out and named under the shelves (the rest
show).

Bot rules stay in Bot-Lab. The file carries a **rule card** (plain text Anthony reads), the build's settings as shown
values, and its frozen test record. Nothing in this repository is a real bot: `test/fixtures/bot-library.json` is a
made-up example and every name and number in it is invented.

## The file

```json
{
  "version": 1,
  "bots": [
    {
      "id": "sample-lantern-fade",
      "name": "Sample Lantern Fade",
      "shelf": "ready",
      "evidence": "L2",
      "sentence": "A made-up example: fades a stalled push back toward the sample midline.",
      "settings": { "Max stop": "18 ticks", "Stall bars": 3 },
      "stats": { "trades": 214, "winRate": 0.584, "avgR": 0.31, "profitFactor": 1.62, "worstDrawdownR": 6.8, "days": 131 },
      "equity": [0.37, 0.18, 0.68, 1.26],
      "ruleCard": "Between 9:30 and 11:00 only.\nStop 2 ticks past the push's far end.",
      "frozen": "2026-09-10",
      "conditions": {
        "timeOfDay": [{ "key": "09:30", "trades": 28, "winRate": 0.61, "avgR": 0.42 }],
        "dayType":   [{ "key": "Trend", "trades": 60, "winRate": 0.55, "avgR": 0.09 }],
        "volBand":   [{ "key": "Normal", "trades": 118, "winRate": 0.6, "avgR": 0.27 }],
        "levelSide": [{ "key": "Line A · short", "trades": 64, "winRate": 0.63, "avgR": 0.48 }]
      }
    }
  ]
}
```

| Key | Type | Rule |
|---|---|---|
| `version` | whole number | `1`. Any other version: the page reads nothing and says which version it found. |
| `bots` | list | At most 50 entries are read. The two shelves keep the file's order. |
| `id` | text | 1 to 64 of letters, digits, `.`, `-`, `_`; unique (a repeat is left out). |
| `name` | text | 1 to 60 characters. The running bot's name (ChartBridge's `bot.name`) is matched against it, case ignored, to show which build is in the slot. |
| `shelf` | text | `"ready"` or `"research"`. |
| `evidence` | text | `L0` to `L9`, Bot-Lab's evidence level, shown as the badge. **Ready needs L1 or higher**; a Ready entry with `L0` is left out. |
| `sentence` | text | 1 to 240 characters: what the build does, in one sentence. |
| `settings` | object | At most 30 names (1 to 40 characters), each a number, `true`/`false` or text up to 80 characters. Shown as written. |
| `stats` | object | `trades` (whole number), `winRate` (0 to 1), `avgR` (R per trade) required; `profitFactor`, `worstDrawdownR` (R, a positive number), `days` (whole number) optional or `null`. No other keys. |
| `equity` | list of numbers | The frozen test record's running total in R after each trade, oldest first; at most 5,000 points. Drawn as the thumbnail and the large curve. |
| `ruleCard` | text | 1 to 4,000 characters, one rule per line (`\n`). Shown as a numbered list; a line's own number (`1.`) is taken off. |
| `frozen` | text or `null` | Optional: the date the build was frozen, `YYYY-MM-DD`. |
| `conditions` | object | Exactly the four lists below (each may be empty), at most 60 cells each. |

Each conditions cell is `{ "key", "trades", "winRate", "avgR" }`, no other keys: `key` text of 1 to 40 characters,
`trades` a whole number of 0 or more, `winRate` 0 to 1, `avgR` R per trade.

| List | Cells |
|---|---|
| `timeOfDay` | 30-minute windows, Eastern time: `key` is the window's start, `"09:30"`, `"10:00"`, ... (`HH:00` or `HH:30`). The page draws every window from the first to the last; a window not in the file shows as 0 trades. |
| `dayType` | The day types, as Bot-Lab names them (`"Trend"`, `"Range"`, `"Gap"`, `"Other"`). |
| `volBand` | The volatility bands (`"Low"`, `"Normal"`, `"High"`). |
| `levelSide` | Level type and side together (`"Line A · short"`). |

A cell with **fewer than 20 trades is faded** on the page: too few to read.

## Shelves

* **Ready (L1 or higher):** the panel offers Shadow, Copilot and, when ChartBridge allows it, Sim auto.
* **Research (shadow only):** while a Research build is the one running, the panel offers Shadow only; Copilot and Sim auto
  are disabled with the reason. ChartBridge's own rails still apply whatever the page shows.

## What the page shows

Each entry: the evidence badge, the sentence, an equity curve thumbnail, trades, won and average R, and "In the slot now"
with today's live record (signals, trades and P&L since ChartBridge started today) when it is the running build. A click
opens it full screen: the large equity curve, the tiles (trades, won, average, profit factor, worst drawdown, days), the
rule card, the settings, the live record, and **Conditions it works best in**: time of day, day type, volatility band,
level type and side, each cell with its trade count. Escape or Close puts it away.

The checks are `BotCore.parseLibrary` in `live/bot-core.js`; `test/bot.test.js` runs them against the example file and
broken copies of it.
