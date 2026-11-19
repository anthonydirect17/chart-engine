# Cutover card text: ChartBridge 0.6.25, the go-live guards (plan step 3.5, the ChartBridge half)

DRAFT card text, not filed. The coordinator files the card at cut time and fills every placeholder in angle brackets:
<CUT_DATE>, <MAIN_COMMIT> (the merge of the release on chart-engine main), <RELEASE_PR>, <DESK_COMMIT> (The Desk's plan
step 3.1 on thedesk main, with `GET /api/legion/cohorts`), <BOTLAB_COMMIT> (Bot-Lab's plan step 3.5 half). ChartBridge
0.6.25 also carries other work (the delta table, Legion's Stop all automation and Flatten and turn off); the release's
one card joins this text with theirs. Plain hyphens only. No account names, PINs, addresses or secrets in the card or the
report.

From: the cloud coordinator. For: WORK's and HOME's local Claude sessions (and the laptop's), with Anthony at the PC. Each
step that installs or edits a file is shown to Anthony first and done on his "okay".

**Anthony's word:** ChartBridge 0.6.25 is installed by Anthony while flat (the plan's row 3.5). **Do it only when Anthony
says go for this card, and only while he is flat in every account.**

## First (before this card)

1. **The Desk:** plan step 3.1 (<DESK_COMMIT>) is installed by the SERVER session, so The Desk answers
   `GET /api/legion/cohorts` with `prop_accounts` (each prop account's firm, from its account type, and its firm's PC).
   Without it ChartBridge 0.6.25 knows no firm: no trader takes a new entry on a prop account and none can go to Auto there
   (Anthony's own trading and the copier are as before).
2. **The account ledger:** every prop account on the PC has its account type on The Desk (Settings), so its firm is known.
   An account with no type has no firm: no trader trades it.
3. **Each firm's PC on Legion (Cohorts):** the one trading PC each firm runs on, written exactly as that PC names itself
   (`/diag`'s `pc`: `config.txt` `pc`, else the Windows computer name; any case). A firm with no PC set: no trader trades
   it anywhere.

## What it is (the go-live guards)

chart-engine main **<MAIN_COMMIT>** (<RELEASE_PR>) carries ChartBridge 0.6.25 with:

- **One direction per firm** (law 9.2): every prop account of a firm on this PC, grouped or not, goes one way only, and
  NQ, MNQ, ES and MES count as one market. A new entry against the firm's open direction is refused and logged, from
  every source: a trader, the copier and Anthony's own ticket. **Nothing is ever closed or cancelled by it**: an open
  position stays as it is, and an exit of an account's own position always goes. Only Anthony's personal account may go
  against a firm's direction.
- **One PC per firm** (law 9.2): a trader picks a roster file, goes to Auto, gets Auto back after a restart and places a
  new entry on a prop account only when that account's firm runs on this PC, and all its prop accounts are of one firm.
  Anthony's own trading is not bound to a PC.
- **The GO size is the file's** (law 9.3): a roster file whose GO size (`live.risk_dollars`) is not its own playbook's is
  not served, so it cannot be picked or armed (Legion lists it with the reason).
- **If the firms cannot be read** (The Desk not reached, a reading older than 10 minutes): a trader's new entries on prop
  accounts wait; Anthony's own ticket and the copier go, and are checked again once the firms are read.

## Steps (each trading PC)

1. Anthony is flat in every account, and no trader is in Auto on a prop account.
2. Install as the release's card says (`update-pc.ps1 -InstallChartBridge` from the clone, then **F5 in the NinjaScript
   Editor while flat**). Note the kept folder's name the install prints (the date and time only).
3. Check, and report each:
   - the Output window shows ChartBridge 0.6.25 and no `firms: The Desk's account ledger (firms and their PCs) could not
     be read` line after the first minute (a line once, then `read again`, is fine);
   - on the chart page's developer view, or by the session, the `groups` message's `firmGuard.state` is `on` and its
     `pc` is this PC's name; each firm Anthony runs here shows `"here": true`;
   - Legion's Go live and Cohorts: a trader on this PC's firm can be picked and armed; one on a firm set to another PC is
     refused with "runs on <PC>, not on this PC" (try only in Shadow, never arm a live account for the test).

## If something is wrong after F5: put 0.6.24 back (the rollback)

1. Anthony is flat in every account. Turn every trader to Shadow first.
2. Show Anthony, then run (from the clone): `powershell -NoProfile -ExecutionPolicy Bypass -File <clone>\nt8\update-pc.ps1
   rollback-chartbridge -Flat`. It shows the version it goes back to (0.6.24) and checks every kept file's sha256 first;
   it changes nothing when a check fails, and says why.
3. **F5 in the NinjaScript Editor while flat.**
4. **After a rollback the go-live guards are gone** (no one direction per firm, no one PC per firm, no GO size check in
   ChartBridge): **no trader goes to Auto on a prop account** until 0.6.25 is back. Bot-Lab's runner still refuses a GO
   whose size is not the file's.
5. Report what went wrong (the Output window's lines, no account names) and stop.

## Report

- each PC: the install's kept folder (date and time only), the step 3 checks, whether the rollback was used and its lines.

## For the release (not for the PCs)

- The release that ships this raises `Version` in `nt8/ChartBridge.cs` to 0.6.25 and `live/COMPAT.json` `minChartBridge`
  together, with a CHANGELOG heading for ChartBridge 0.6.25. `test/lifecycle.test.js` and `test/account-types.test.js` pin
  both today (0.6.24 and 0.6.2), so the release changes the two and those tests in one step.
- The page needs nothing new from these guards: a refusal reaches the pages as every refusal does (`reject` and `status`).
