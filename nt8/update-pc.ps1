<#
.SYNOPSIS
  Keeps this trading PC's chart page up to date, and gets a new ChartBridge ready for Anthony to install by hand.

.DESCRIPTION
  Run from the chart-engine clone (HOME, the laptop, WORK):
    powershell -NoProfile -ExecutionPolicy Bypass -File nt8\update-pc.ps1 <command>
  The scheduled task runs a pinned copy, updater\bin\update-pc.ps1, that changes only when Anthony runs register or
  -InstallChartBridge. The automatic path never moves the clone: it fetches, and stages from git objects.

  Commands:
    status                what is installed, what is waiting, and why (asks ChartBridge's /diag and saves the
                          version it reports in state.json; never writes a page or ChartBridge file). The task as
                          Task Scheduler keeps it: Disabled, or a last run that broke (its LastTaskResult), ends
                          with STOP; a task whose state folder is not this window's has its own last run said
    check                 dry run: fetches main and says what `update` would do; changes nothing
    update                the automatic path (the scheduled task runs this): installs the newest commit on main
                          whose CI is green on ubuntu-latest and windows-latest, only when its page works with the
                          ChartBridge compiled on this PC; stages a new ChartBridge but never installs it. A network
                          that is not up yet (the run at sign-in) is waited for up to 2 minutes, then the run ends
                          quietly (offline) until the next one
    -InstallChartBridge   run by Anthony while flat: copies the staged add-on files (and the matching page), then
                          Anthony presses F5 in the NinjaScript Editor while flat
    rollback              puts the previous page files back (and skips that commit until a newer one is on main)
    repair                page files only, never ChartBridge: finishes or undoes a cut-off install, or writes a whole
                          page from staged\, previous\ or the clone's page files
    pause / resume        a manual switch for the automatic path (off by default)
    register / unregister the scheduled task for this Windows user: at sign-in, and daily at each -DailyAt time (New
                          York time, 09:00 and 17:00 by default: Anthony 2026-10-23, every updater checks twice a
                          day and at sign-in; -DailyAt 08:30 for one time, -DailyAt 09:00,17:00 for a list). The
                          task starts hidden, through a one-line launcher (see "Hidden start")

  Rules (Anthony, 2026-09-30):
    - The automatic path never writes a .cs file into bin\Custom\AddOns: the next F5 anyone pressed would compile it
      at a random moment, possibly with a position open. Only -InstallChartBridge does, after Anthony says he is flat.
    - config.txt and pin.txt in Documents\NinjaTrader 8\ChartBridge are this PC's own and are never touched.
    - The page files are written one by one through a temporary file and an atomic replace, so ChartBridge never
      serves half a file; an open page keeps its loaded code and only shows "Update ready: reload when flat".
      ChartBridge maps each URL straight to www\<path>, so there is no one-step switch of a whole set: a journal
      (updater\swap.json) makes an interrupted install finish or undo itself at the start of the next run.
    - Windows PowerShell 5.1 and git only. No PowerShell command strings: scripts run with -File.

  State and logs: Documents\NinjaTrader 8\ChartBridge\updater\ (state.json, status.json, update.log, swap.json while a
  page install runs, staged\, previous\, previous-addons\, bin\, paused). Only update.json (versions, no secrets) is written into the served www folder.

  Hidden start (Anthony, 2026-10-22: every scheduled program of ours runs hidden). powershell.exe -WindowStyle Hidden
  still flashes a console while PowerShell starts, so register writes a one-line ASCII launcher,
  updater\bin\update-pc.hidden.vbs:
    WScript.Quit CreateObject("WScript.Shell").Run("<the command line below, quotes doubled>", 0, True)
  and the task runs wscript.exe //B "<that launcher>" (//B: batch mode, so WScript never shows an error dialog; same
  working folder, triggers, user, settings and time limit). Window
  style 0 is hidden; True waits, so the exit code comes back and Task Scheduler's Running and Last Result stay true. The
  command line is exactly the one the task ran before: Windows PowerShell with -File on the pinned copy, update -Repo
  <clone>. register writes the launcher first (and reads it back), then changes the task, then pins (the pinned copy and
  pinned.json only after the task is registered, 1.39.1): a launcher that cannot be written, or a task that cannot be
  registered, fails register and changes nothing (the launcher put back byte for byte; never a visible task again). register keeps what the current
  task runs: its -Repo, read from its arguments or from the Run line of the launcher it starts (ours, or a hand-made one
  in C:\SchwabDesk_bulk\hidden); another clone is refused unless -Repo is given, and so is a task whose command cannot
  be read (unregister first then). unregister removes the launcher too. status prints the command the task runs and
  checks the launcher: missing, unreadable or not exactly the line register writes, status says so and ends with STOP.
  Migration without a job per PC (Anthony 2026-10-23): the automatic path never changes the pinned copy or the task's
  action, so -InstallChartBridge (after it re-pins the task's copy) moves a task that is not started by this tool's own launcher
  (plain powershell.exe, or a hand-made launcher in C:\SchwabDesk_bulk\hidden) to it, once, through register's own
  code: -Repo kept (refused by name otherwise), pinned.json's daily time 17:05 or 09:00 moved to 09:00 and 17:00 (another
  time kept), and it prints what it kept. Refused, and said: an elevated window, a task that runs as another user or
  with a logon type other than Interactive, a task whose script is not the pinned copy. A refused or failed move changes nothing (the launcher it wrote goes, pinned.json is written
  only after the task) and never stops -InstallChartBridge. The move needs a copy that has this code: one run from an
  up to date clone, or register; a pinned copy older than this change only pins the new copy, and the move then
  happens at the next -InstallChartBridge. Task Scheduler applies a changed action from the task's next start. Until
  then each automatic run logs one WARN line: "the task still starts without the hidden launcher: it is migrated at
  the next -InstallChartBridge (unless it is refused there; see its output) or update-pc.ps1 register".
  A task behind a hand-made launcher (a .vbs in C:\SchwabDesk_bulk\hidden, as WORK and HOME made theirs on 2026-10-22,
  with or without //B, its Run line plain or cmd /s /c "cd /d "<folder>" && <command>") is also moved by the task's own
  automatic run once a pinned copy with this change runs it (Invoke-AutoTaskMigration): the same move and refusals, only
  when this run is the pinned copy, one WARN line naming why when refused; the hand-made .vbs stays on disk. A plain
  powershell.exe task still moves only at -InstallChartBridge or register.
  Two daily checks (Anthony 2026-10-23: 09:00 and 17:00 New York time, and at sign-in). pinned.json carries dailyTimes
  (the list) and dailyAt (its first time, for a pinned copy older than this change). A pin written before this change
  (dailyAt only: 09:00, 17:05 or none) reads 09:00 and 17:00; another single time is kept. A task on its own hidden
  launcher with one daily trigger gets the 17:00 one from the automatic run of a pinned copy that has this change: a
  change of the schedule only (the action, the launcher and the pinned copy stay as they are), and only in the task's own
  run (the task starts through its own launcher, which runs the pinned copy, and this run is that copy; not elevated; the
  task's own user, a task that runs only while signed in). Every other change of the daily triggers (a move for DST or a
  time zone) is made only in the task's own run too (the same checks, without the launcher one). An update run of the
  clone's copy changes no trigger and says so; the pinned copy (updater\bin\update-pc.ps1, $u in the README) run by
  hand counts as the task's own run when it is not elevated and runs as the task's user. A PC
  picks it up after its next -InstallChartBridge or register (either pins a copy with this
  change); a task not yet on the hidden launcher gets both at that migration. Two triggers never run an update at the same
  moment: the task never starts twice at once (IgnoreNew), and every run takes updater.lock first (a run that finds it
  held says busy and changes nothing).
  Time limit: when Task Scheduler stops the task at its 30 minutes it stops wscript.exe, and the PowerShell under it
  may keep running. That run still holds updater.lock (a file held open, freed by Windows when the process ends), so
  every later run says busy and changes nothing until it ends; each git call has
  its own 3 minute limit and is ended with what it started (taskkill /T). A PowerShell that hangs for good outside git
  would keep the updater busy until sign-out or a restart: update.log and status show it.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('status', 'check', 'update', 'rollback', 'repair', 'pause', 'resume', 'register', 'unregister', 'install-chartbridge')]
  [string]$Command = 'status',
  [switch]$InstallChartBridge,
  [switch]$Yes,
  # The daily checks, in New York time, as a list: 09:00,17:00 (one argument from a command line) or a PowerShell list.
  # Anthony, 2026-10-23: twice a day, at 09:00 and 17:00, and at sign-in (it was 09:00 alone that morning, 17:05 before).
  # One time given (-DailyAt 08:30) is one daily check. The updater only installs page files (an open page keeps the code
  # it loaded and says "Update ready: reload when flat") and never installs ChartBridge, so a check never changes what is
  # open while he trades. A PC registered before reads its pinned.json as Get-PinTimes says.
  [ValidatePattern('^([01][0-9]|2[0-3]):[0-5][0-9](,([01][0-9]|2[0-3]):[0-5][0-9])*$')]
  [string[]]$DailyAt = '09:00,17:00',
  [string]$TaskName = 'ChartEngine Updater',
  # The clone, for the pinned copy in updater\bin that the scheduled task runs (register passes it).
  [string]$Repo = '',
  # Tests only: load the functions without running a command.
  [switch]$NoRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:UpdaterSelf = $MyInvocation.MyCommand.Path
$script:Bound = @{}                            # the options given on this command line (register keeps the task's others)
foreach ($k in $PSBoundParameters.Keys) { $script:Bound[$k] = $PSBoundParameters[$k] }
$script:RequiredChecks = @('unit (ubuntu-latest)', 'unit (windows-latest)')   # .github/workflows/test.yml
$script:GoodConclusions = @('success', 'neutral', 'skipped')
$script:Remote = 'origin'
$script:Branch = 'main'
$script:IsWin = ([Environment]::OSVersion.Platform -eq 'Win32NT')
$script:StaleLockMinutes = 10       # a ref lock older than this was left by an ended fetch (the fetch's time limit is 3 minutes)
$script:ManifestPath = 'nt8/install-files.json'
$script:CompatPath = 'live/COMPAT.json'
$script:SelfPath = 'nt8/update-pc.ps1'
$script:VersionFile = 'update.json'          # the one file the updater writes into www (the page polls it)
$script:LogMaxBytes = 1000000
$script:LogKeep = 3
$script:AddOnWriteAllowed = $false             # only Invoke-InstallChartBridge sets it, after Anthony confirms
$script:UpdaterStopped = $false                # the pinned copy failed its own check (Test-PinnedSelf)
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
# 0.3.8: the run at sign-in can come before the network is up ("Failed to connect to github.com port 443"): `update`
# tries the fetch again for up to FetchWaitSec, then gives up quietly (outcome offline) until the next run.
$script:DailyAtDefault = '09:00,17:00'    # the -DailyAt default above, and a pin written before it (Get-PinTimes)
$script:DailyAtBefore = @('17:05', '09:00')   # the old single defaults: a pin written before with one moves to DailyAtDefault
$script:HiddenLauncherName = 'update-pc.hidden.vbs'   # the task's hidden launcher, in updater\bin (register writes it)
$script:HandLauncherDir = 'C:\SchwabDesk_bulk\hidden'   # where the hand-made launchers of 2026-10-22 are (Invoke-AutoTaskMigration)
# This script's own parameters and PowerShell's common ones (CmdletBinding), as PowerShell binds a task's command line to them
# (Get-CommandOptions; a test checks the list against the param block above)
$script:OwnParams = @('Command', 'InstallChartBridge', 'Yes', 'DailyAt', 'TaskName', 'Repo', 'NoRun',
  'Verbose', 'Debug', 'ErrorAction', 'WarningAction', 'InformationAction', 'ErrorVariable', 'WarningVariable', 'InformationVariable',
  'OutVariable', 'OutBuffer', 'PipelineVariable')
# and the common ones' own short names (-ea Stop binds as -ErrorAction Stop; review of #72)
$script:OwnAliases = @{ vb = 'Verbose'; db = 'Debug'; ea = 'ErrorAction'; wa = 'WarningAction'; infa = 'InformationAction'; ev = 'ErrorVariable';
  wv = 'WarningVariable'; iv = 'InformationVariable'; ov = 'OutVariable'; ob = 'OutBuffer'; pv = 'PipelineVariable' }
$script:FetchWaitSec = 120
$script:FetchRetrySec = 10
# 0.3.8: an antivirus (Norton on HOME) can hold the freshly extracted staged.tmp\files.zip for a moment ("Access to the
# path is denied"): its delete is tried DeleteTries times, DeleteRetryMs apart (about 5 seconds in all).
$script:DeleteTries = 10
$script:DeleteRetryMs = 500
# A page target: plain names joined by /, no .., no drive, no trailing dot or space (Windows trims those)
$script:TargetPattern = '^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*(/[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*)*$'

# ------------------------------------------------------------------------------------------------ paths

function Initialize-Paths([string]$Repo, [string]$NtFolder) {
  if (-not $Repo) { $Repo = Split-Path -Parent (Split-Path -Parent $script:UpdaterSelf) }   # nt8\update-pc.ps1 in the clone
  if (-not $NtFolder) {
    $docs = [Environment]::GetFolderPath('MyDocuments')          # as nt8\install.ps1
    if (-not $docs) { $docs = Join-Path $HOME 'Documents' }      # not on Windows (tests)
    $NtFolder = Join-Path $docs 'NinjaTrader 8'
  }
  $cb = Join-Path $NtFolder 'ChartBridge'
  $dir = Join-Path $cb 'updater'
  $script:P = @{
    Repo = $Repo; Nt = $NtFolder; ChartBridge = $cb; Www = (Join-Path $cb 'www')
    AddOns = (Join-Path (Join-Path (Join-Path $NtFolder 'bin') 'Custom') 'AddOns'); Config = (Join-Path $cb 'config.txt')
    Dir = $dir; State = (Join-Path $dir 'state.json'); Status = (Join-Path $dir 'status.json')
    Log = (Join-Path $dir 'update.log'); Lock = (Join-Path $dir 'updater.lock'); Paused = (Join-Path $dir 'paused')
    Staged = (Join-Path $dir 'staged'); Previous = (Join-Path $dir 'previous'); PrevAddOns = (Join-Path $dir 'previous-addons')
    Journal = (Join-Path $dir 'swap.json'); Bin = (Join-Path $dir 'bin'); PrevNext = (Join-Path $dir 'previous-next')
    NetWait = (Join-Path $dir 'network-wait')
  }
}

function Get-LocalPath([string]$Root, [string]$Rel) {
  return (Join-Path $Root ($Rel.Replace('/', [IO.Path]::DirectorySeparatorChar)))
}

# ------------------------------------------------------------------------------------------------ small helpers

# 3 d 4 h, 2 h 5 min, 7 min
function Format-Age([TimeSpan]$Age) {
  if ($Age.TotalDays -ge 1) { return "$([int][Math]::Floor($Age.TotalDays)) d $($Age.Hours) h" }
  if ($Age.TotalHours -ge 1) { return "$([int][Math]::Floor($Age.TotalHours)) h $($Age.Minutes) min" }
  return "$([int][Math]::Max(0, [Math]::Floor($Age.TotalMinutes))) min"
}

function Get-NowMs { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function Get-Short([string]$Sha) { if ($Sha -and $Sha.Length -ge 7) { return $Sha.Substring(0, 7) } return "$Sha" }

function Write-Log([string]$Message, [string]$Level = 'INFO') {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + " $Level $Message"
  Write-Host $line
  try {
    if (-not (Test-Path $script:P.Dir)) { New-Item -ItemType Directory -Force -Path $script:P.Dir | Out-Null }
    if ((Test-Path $script:P.Log) -and (Get-Item $script:P.Log).Length -gt $script:LogMaxBytes) {
      for ($i = $script:LogKeep; $i -ge 1; $i--) {
        $older = "$($script:P.Log).$i"
        if ($i -eq $script:LogKeep) { if (Test-Path $older) { Remove-Item -Force $older } }
        else { if (Test-Path $older) { Move-Item -Force $older "$($script:P.Log).$($i + 1)" } }
      }
      Move-Item -Force $script:P.Log "$($script:P.Log).1"
    }
    [IO.File]::AppendAllText($script:P.Log, $line + [Environment]::NewLine, $script:Utf8)
  } catch { Write-Host "(the log could not be written: $($_.Exception.Message))" }
}

function ConvertTo-Hashtable($Value) {
  if ($null -eq $Value) { return $null }
  if ($Value -is [System.Collections.IDictionary]) {
    $h = @{}
    foreach ($k in $Value.Keys) { $h[$k] = ConvertTo-Hashtable $Value[$k] }
    return $h
  }
  if ($Value -is [System.Management.Automation.PSCustomObject]) {
    $h = @{}
    foreach ($p in $Value.PSObject.Properties) { $h[$p.Name] = ConvertTo-Hashtable $p.Value }
    return $h
  }
  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
    $list = New-Object System.Collections.ArrayList
    foreach ($item in $Value) { [void]$list.Add((ConvertTo-Hashtable $item)) }
    return , $list.ToArray()
  }
  return $Value
}

function ConvertFrom-JsonText([string]$Text) {
  if (-not $Text -or -not $Text.Trim()) { return $null }
  return (ConvertTo-Hashtable (ConvertFrom-Json -InputObject $Text))
}

function Read-JsonFile([string]$Path) {
  try {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (ConvertFrom-JsonText ([IO.File]::ReadAllText($Path, $script:Utf8)))
  } catch { return $null }
}

function Get-Field($Table, [string]$Name, $Default = $null) {
  if ($null -ne $Table -and $Table -is [System.Collections.IDictionary] -and $Table.Contains($Name) -and $null -ne $Table[$Name]) { return $Table[$Name] }
  return $Default
}

# Replace a file in one step. ChartBridge reads page files with File.ReadAllBytes (read sharing only), so a
# replace can meet a sharing violation for a moment: it is tried again for about three seconds.
function Move-FileAtomic([string]$Source, [string]$Dest) {
  $last = $null
  for ($try = 0; $try -lt 30; $try++) {
    try {
      if (Test-Path -LiteralPath $Dest) { [IO.File]::Replace($Source, $Dest, [NullString]::Value) }
      else { [IO.File]::Move($Source, $Dest) }
      return
    } catch [System.IO.IOException], [System.UnauthorizedAccessException] {
      $last = $_.Exception
      Start-Sleep -Milliseconds 100
    }
  }
  throw "could not replace ${Dest}: $($last.Message)"
}

function Write-TextAtomic([string]$Path, [string]$Text) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $tmp = "$Path.upd-tmp"
  [IO.File]::WriteAllText($tmp, $Text, $script:Utf8)
  Move-FileAtomic $tmp $Path
}

function Write-JsonAtomic([string]$Path, $Value) {
  Write-TextAtomic $Path (ConvertTo-Json -InputObject $Value -Depth 12)
}

function Remove-Dir([string]$Path) {
  if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

# Waits, one place (the tests make it instant and count it).
function Wait-Ms([int]$Ms) { Start-Sleep -Milliseconds $Ms }
function Remove-FileOnce([string]$Path) { Remove-Item -LiteralPath $Path -Force }

# Deletes a file another program may hold for a moment (an antivirus scanning a file just written): tried again for
# about five seconds before the error is passed on.
function Remove-FileRetry([string]$Path) {
  for ($try = 1; ; $try++) {
    try { if (Test-Path -LiteralPath $Path) { Remove-FileOnce $Path }; return }
    catch {
      if ($try -ge $script:DeleteTries) { throw "could not delete $Path after $try tries over about $([int]($script:DeleteTries * $script:DeleteRetryMs / 1000)) s (another program, an antivirus perhaps, holds it): $($_.Exception.Message)" }
      Wait-Ms $script:DeleteRetryMs
    }
  }
}

function ConvertTo-VersionOrNull([string]$Text) {
  if ($Text -and $Text.Trim() -match '^\d+\.\d+(\.\d+){0,2}$') { return [version]$Text.Trim() }
  return $null
}

function Get-TextHash([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $bytes = $sha.ComputeHash($script:Utf8.GetBytes($Text)) } finally { $sha.Dispose() }
  return (-join ($bytes | ForEach-Object { $_.ToString('x2') }))
}

# SHA-256 of a file (not Get-FileHash: that is a script function of a module that can fail to load in Windows
# PowerShell 5.1 when PowerShell 7's module path is inherited).
function Get-FileSha256([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $fs = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
  try { $bytes = $sha.ComputeHash($fs) } finally { $fs.Dispose(); $sha.Dispose() }
  return (-join ($bytes | ForEach-Object { $_.ToString('x2') }))
}

# One id for a set of page files: which files, and every byte of each. Two commits with the same page files have
# the same build, so an update that changed only nt8\ or the docs shows no "Update ready" on the page.
function Get-BuildId([string]$Root, [string[]]$Targets) {
  $lines = foreach ($t in ($Targets | Sort-Object)) {
    $f = Get-LocalPath $Root $t
    if (Test-Path -LiteralPath $f) { "$t " + (Get-FileSha256 $f) }
    else { "$t missing" }
  }
  return (Get-TextHash ($lines -join "`n")).Substring(0, 16)
}

# ------------------------------------------------------------------------------------------------ programs

function Format-Arg([string]$Arg) {
  if ($Arg -eq '') { return '""' }
  if ($Arg -notmatch '[\s"]') { return $Arg }
  $s = $Arg -replace '(\\*)"', '$1$1\"'
  $s = $s -replace '(\\+)$', '$1$1'
  return '"' + $s + '"'
}

# A program with an argument list and a time limit. PowerShell itself is never started this way with a command
# string (Norton on WORK blocks -EncodedCommand; see the test that guards it).
function Invoke-Native([string]$Exe, [string[]]$ArgList, [int]$TimeoutSec = 120) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = (($ArgList | ForEach-Object { Format-Arg $_ }) -join ' ')
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $script:Utf8
  $psi.StandardErrorEncoding = $script:Utf8
  # git never asks anything from the hidden task: no terminal prompt, no Git Credential Manager window, no askpass
  # window, and ssh in batch mode (a key with a passphrase fails instead of asking)
  $psi.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
  $psi.EnvironmentVariables['GCM_INTERACTIVE'] = 'never'
  $psi.EnvironmentVariables['GIT_ASKPASS'] = ''
  $psi.EnvironmentVariables['SSH_ASKPASS'] = ''
  $psi.EnvironmentVariables['GIT_SSH_COMMAND'] = 'ssh -o BatchMode=yes'
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync()
  $err = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) {
    Stop-ProcessTree $p
    return @{ code = -1; out = ''; err = "timed out after $TimeoutSec s" }
  }
  $p.WaitForExit()
  return @{ code = $p.ExitCode; out = $out.Result; err = $err.Result }
}

# A git that timed out is ended with everything it started (git-remote-https, Git Credential Manager): ending git.exe
# alone leaves them holding the fetch, and a ref lock behind (as botlab_update.ps1). Windows: taskkill /T; .NET Core: Kill(true).
function Stop-ProcessTree($Proc) {
  if ($script:IsWin) {
    try { [void](Invoke-Native (Join-Path $env:SystemRoot 'System32\taskkill.exe') @('/T', '/F', '/PID', [string]$Proc.Id) 30) } catch { }
  } else {
    try { $Proc.Kill($true) } catch { }
  }
  try { if (-not $Proc.HasExited) { $Proc.Kill() } } catch { }
}

function Get-GitExe {
  $c = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  return $c.Source
}

# Every git call of this tool goes through here. Only subcommands that read, or fetch origin into
# refs/remotes, are allowed: nothing here can move Anthony's clone (no checkout, merge, pull, reset ...).
$script:GitAllowed = @('fetch', 'rev-parse', 'show', 'cat-file', 'archive', 'remote', 'symbolic-ref', 'rev-list', 'merge-base', 'hash-object', 'ls-tree')

# Three allowed subcommands also have a writing form, so their whole argument list is checked: symbolic-ref reads
# one ref (a second name would write it, -d deletes it), remote only runs get-url, hash-object never writes (-w).
function Test-GitArgs([string[]]$ArgList) {
  $sub = $ArgList[0]
  if ($script:GitAllowed -notcontains $sub) { return "git $sub is not allowed in update-pc.ps1" }
  $rest = @($ArgList | Select-Object -Skip 1)
  if ($sub -eq 'symbolic-ref') {
    $names = @($rest | Where-Object { $_ -notmatch '^-' })
    $flags = @($rest | Where-Object { $_ -match '^-' })
    if ($names.Count -ne 1 -or @($flags | Where-Object { @('-q', '--quiet', '--short') -notcontains $_ }).Count) { return "git symbolic-ref is allowed only as a read (symbolic-ref -q --short <ref>), not '$($rest -join ' ')'" }
  }
  if ($sub -eq 'remote') {
    if ($rest.Count -ne 2 -or $rest[0] -ne 'get-url' -or $rest[1] -match '^-') { return "git remote is allowed only as 'remote get-url <name>', not '$($rest -join ' ')'" }
  }
  if ($sub -eq 'hash-object') {
    $dd = [array]::IndexOf([string[]]$rest, '--')
    $opts = @(); if ($dd -ge 0) { $opts = @($rest | Select-Object -First $dd) }
    if ($dd -lt 0 -or $rest.Count -le $dd + 1 -or @($opts | Where-Object { $_ -notmatch '^--path=' -and $_ -ne '--no-filters' }).Count) { return "git hash-object is allowed only as 'hash-object [--path=<p>] -- <file>' (never -w), not '$($rest -join ' ')'" }
  }
  return $null
}

function Invoke-Git([string[]]$ArgList, [int]$TimeoutSec = 120) {
  $refused = Test-GitArgs $ArgList
  if ($refused) { throw $refused }
  $git = Get-GitExe
  if (-not $git) { return @{ code = -1; out = ''; err = 'git is not on PATH' } }
  # never a prompt or a window; never a gc or maintenance run started in Anthony's clone by a fetch
  $quiet = @('-c', 'credential.interactive=never', '-c', 'core.sshCommand=ssh -o BatchMode=yes', '-c', 'core.askPass=',
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false')
  return (Invoke-Native $git (@('-C', $script:P.Repo) + $quiet + $ArgList) $TimeoutSec)
}

# The git blob id of a file on disk, as it would be stored at <RepoPath> (line endings normalized as git does).
function Get-BlobId([string]$File, [string]$RepoPath) {
  $r = Invoke-Git @('hash-object', "--path=$RepoPath", '--', $File) 60
  if ($r.code -ne 0) { return $null }
  return $r.out.Trim()
}

# The blob ids of paths in a commit: @{ path = blob }.
function Get-CommitBlobs([string]$Sha, [string[]]$Paths) {
  $r = Invoke-Git (@('ls-tree', '-r', $Sha, '--') + $Paths) 60
  $h = @{}
  if ($r.code -ne 0) { return $h }
  foreach ($line in ($r.out -split "`r?`n")) {
    $m = [regex]::Match($line, '^\d+ blob ([0-9a-f]+)\t(.+)$')
    if ($m.Success) { $h[$m.Groups[2].Value] = $m.Groups[1].Value }
  }
  return $h
}

function Get-LastLine([string]$Text) {
  $lines = @($Text -split "`r?`n" | Where-Object { $_.Trim() })
  if ($lines.Count -eq 0) { return '' }
  return $lines[$lines.Count - 1].Trim()
}

# ------------------------------------------------------------------------------------------------ state

function Read-State {
  $s = Read-JsonFile $script:P.State
  if ($null -eq $s) { $s = @{} }
  foreach ($k in @('page', 'chartBridge', 'lastRun')) { if (-not ($s[$k] -is [System.Collections.IDictionary])) { $s[$k] = @{} } }
  if (-not $s.Contains('ciGreen')) { $s['ciGreen'] = @() }
  return $s
}

function Save-State($State) {
  $State['schema'] = 1
  Write-JsonAtomic $script:P.State $State
}

# ------------------------------------------------------------------------------------------------ CI (GitHub)

function ConvertTo-RepoSlug([string]$Url) {
  $m = [regex]::Match("$Url".Trim(), 'github\.com[:/]+([^/\s]+)/([^/\s]+?)(\.git)?/?$')
  if (-not $m.Success) { return $null }
  return "$($m.Groups[1].Value)/$($m.Groups[2].Value)"
}

function Get-RepoSlug {
  $r = Invoke-Git @('remote', 'get-url', $script:Remote) 30
  if ($r.code -ne 0) { return $null }
  return (ConvertTo-RepoSlug $r.out)
}

# One GET to the GitHub API, without a token: chart-engine is public, and the API allows 60 requests an hour per
# address without one. A pass makes two (check runs and statuses), and a green commit is remembered in state.json
# and never asked about again, so a PC uses a few a day.
function Invoke-GitHubJson([string]$Path) {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
  $headers = @{ 'Accept' = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28'; 'User-Agent' = 'chart-engine-pc-updater' }
  $res = Invoke-WebRequest -Uri ('https://api.github.com' + $Path) -Headers $headers -UseBasicParsing -TimeoutSec 20
  return (ConvertFrom-JsonText ([string]$res.Content))
}

# Did CI pass for a commit? The same rule as The Desk's updater (ops/updater.py GitHubCI), plus the two jobs Anthony
# named: 'unit (ubuntu-latest)' and 'unit (windows-latest)' must both be there and green.
#   success  both required jobs green, and every other check and status finished green
#   pending  no results yet, or something still running
#   failure  a check or status failed, or a required job finished without success
#   unknown  GitHub could not be asked (offline, rate limited)
function Get-CiState([string]$Slug, [string]$Sha) {
  if (-not $Slug) { return @{ state = 'unknown'; detail = 'the GitHub repo is not known from the origin URL' } }
  try {
    $checks = @()
    for ($page = 1; $page -le 5; $page++) {
      $d = Invoke-GitHubJson "/repos/$Slug/commits/$Sha/check-runs?per_page=100&page=$page"
      $batch = @(Get-Field $d 'check_runs' @())
      $checks += $batch
      if ($batch.Count -lt 100) { break }
    }
    $st = Invoke-GitHubJson "/repos/$Slug/commits/$Sha/status?per_page=100"
    $statuses = @(Get-Field $st 'statuses' @())
  } catch {
    $msg = $_.Exception.Message
    $code = $null
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    if ($code -eq 403 -or $code -eq 429) { return @{ state = 'unknown'; detail = "GitHub answered $code (rate limited: 60 requests an hour without a token)" } }
    if ($code) { return @{ state = 'unknown'; detail = "GitHub answered $code" } }
    return @{ state = 'unknown'; detail = "GitHub could not be read ($msg)" }
  }
  return (Resolve-CiState $checks $statuses)
}

function Resolve-CiState($Checks, $Statuses) {
  $Checks = @($Checks); $Statuses = @($Statuses)
  if ($Checks.Count -eq 0 -and $Statuses.Count -eq 0) { return @{ state = 'pending'; detail = 'no CI results for this commit yet' } }
  $bad = @()
  foreach ($c in $Checks) {
    if ((Get-Field $c 'status') -eq 'completed' -and $script:GoodConclusions -notcontains (Get-Field $c 'conclusion')) { $bad += "$(Get-Field $c 'name')=$(Get-Field $c 'conclusion')" }
  }
  foreach ($s in $Statuses) { if (@('failure', 'error') -contains (Get-Field $s 'state')) { $bad += "$(Get-Field $s 'context')=$(Get-Field $s 'state')" } }
  if ($bad.Count) { return @{ state = 'failure'; detail = 'failed: ' + ($bad -join ', ') } }
  $running = @()
  foreach ($c in $Checks) { if ((Get-Field $c 'status') -ne 'completed') { $running += [string](Get-Field $c 'name') } }
  foreach ($s in $Statuses) { if ((Get-Field $s 'state') -eq 'pending') { $running += [string](Get-Field $s 'context') } }
  if ($running.Count) { return @{ state = 'pending'; detail = 'still running: ' + ($running -join ', ') } }
  foreach ($need in $script:RequiredChecks) {
    $hit = @($Checks | Where-Object { (Get-Field $_ 'name') -eq $need -and (Get-Field (Get-Field $_ 'app' @{}) 'slug') -eq 'github-actions' })
    if ($hit.Count -eq 0) { return @{ state = 'pending'; detail = "no '$need' result yet" } }
    if (@($hit | Where-Object { (Get-Field $_ 'conclusion') -eq 'success' }).Count -eq 0) { return @{ state = 'failure'; detail = "'$need' did not succeed" } }
  }
  return @{ state = 'success'; detail = 'green: ' + ($script:RequiredChecks -join ', ') }
}

# ------------------------------------------------------------------------------------------------ ChartBridge's version

function Get-ChartBridgePort {
  $port = 8765
  try {
    if (Test-Path -LiteralPath $script:P.Config) {       # read only: config.txt is this PC's own
      foreach ($raw in [IO.File]::ReadAllLines($script:P.Config)) {
        $line = $raw.Trim()
        if ($line -match '^port\s*=\s*(\d+)\s*$') { $port = [int]$Matches[1] }
      }
    }
  } catch { }
  return $port
}

# GET http://localhost:<port>/diag: read only, answered to a program on this PC (ChartBridge checks the source
# address first; /diag needs no PIN and no Origin). The Host must be localhost:<port> (HttpListener's prefix).
function Get-DiagVersion {
  $url = "http://localhost:$(Get-ChartBridgePort)/diag"
  try {
    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.Method = 'GET'
    $req.Proxy = $null
    $req.Timeout = 3000
    $req.ReadWriteTimeout = 3000
    $res = $req.GetResponse()
    try {
      $reader = New-Object System.IO.StreamReader($res.GetResponseStream(), $script:Utf8)
      $text = $reader.ReadToEnd()
    } finally { $res.Close() }
    $d = ConvertFrom-JsonText $text
    $v = [string](Get-Field $d 'version' '')
    if (-not $v) { return @{ ok = $false; version = $null; detail = "$url answered without a version" } }
    return @{ ok = $true; version = $v; detail = "$url" }
  } catch {
    return @{ ok = $false; version = $null; detail = "ChartBridge does not answer at $url (NinjaTrader closed?)" }
  }
}

# The Version string of the ChartBridge.cs now in AddOns (read only). It is what the next F5 would compile, and what
# the last one compiled unless the file was changed since; install.ps1 and hand copies show up here.
function Get-AddOnVersion {
  try {
    $f = Join-Path $script:P.AddOns 'ChartBridge.cs'
    if (-not (Test-Path -LiteralPath $f)) { return $null }
    $m = [regex]::Match([IO.File]::ReadAllText($f), 'public const string Version = "([^"]+)"')
    if ($m.Success -and (ConvertTo-VersionOrNull $m.Groups[1].Value)) { return $m.Groups[1].Value }
  } catch { }
  return $null
}

function Get-LowerVersion([string[]]$Versions) {
  $low = $null
  foreach ($v in $Versions) {
    if (-not (ConvertTo-VersionOrNull $v)) { continue }
    if (-not $low -or (ConvertTo-VersionOrNull $v) -lt (ConvertTo-VersionOrNull $low)) { $low = $v }
  }
  return $low
}

# The ChartBridge compiled on this PC. Never a guess:
#   - /diag when ChartBridge answers (the newest observation always wins, a lower one too: Anthony may go back).
#   - NinjaTrader closed: what this tool recorded, the newest of the last /diag and the last -InstallChartBridge copy
#     (the lower of the two while that copy has not been seen compiled), and never above the Version in
#     AddOns\ChartBridge.cs. Nothing recorded: unknown.
function Get-CompiledChartBridge($State) {
  $cbs = $State['chartBridge']
  $diag = Get-DiagVersion
  if ($diag.ok) {
    $before = [string](Get-Field $cbs 'diagVersion' '')
    if ((ConvertTo-VersionOrNull $before) -and (ConvertTo-VersionOrNull $diag.version) -and (ConvertTo-VersionOrNull $diag.version) -lt (ConvertTo-VersionOrNull $before)) {
      Write-Log "ChartBridge went down from $before to $($diag.version) (/diag); counting $($diag.version)" 'WARN'
    }
    $cbs['diagVersion'] = $diag.version
    $cbs['diagSeenAt'] = Get-NowMs
    $inst = Get-Field $cbs 'installed'
    if ($inst -and (Get-Field $inst 'version') -eq $diag.version) { $inst['confirmed'] = $true }
    if (-not (ConvertTo-VersionOrNull $diag.version)) { return @{ version = $null; source = 'diag'; detail = "/diag says '$($diag.version)', not a version this tool can compare" } }
    return @{ version = $diag.version; source = 'diag'; detail = 'ChartBridge /diag' }
  }
  $seen = [string](Get-Field $cbs 'diagVersion' '')
  $seenAt = [long](Get-Field $cbs 'diagSeenAt' 0)
  $inst = Get-Field $cbs 'installed'
  $instV = ''; $instAt = [long]0; $confirmed = $false
  if ($inst) { $instV = [string](Get-Field $inst 'version' ''); $instAt = [long](Get-Field $inst 'at' 0); $confirmed = [bool](Get-Field $inst 'confirmed' $false) }
  $recorded = $null; $how = ''
  if ((ConvertTo-VersionOrNull $seen) -and (-not $instV -or $seenAt -gt $instAt)) { $recorded = $seen; $how = "last seen in /diag" }
  elseif ($instV -and $confirmed) { $recorded = $instV; $how = "copied by -InstallChartBridge and seen compiled" }
  elseif ($instV -and (ConvertTo-VersionOrNull $seen)) { $recorded = Get-LowerVersion @($seen, $instV); $how = "copied $instV, F5 not seen yet; last seen compiled $seen" }
  if (-not $recorded) {
    if ($instV) { return @{ version = $null; source = 'none'; detail = "ChartBridge $instV was copied but never seen compiled, and $($diag.detail)" } }
    return @{ version = $null; source = 'none'; detail = "not known: $($diag.detail), and this tool has recorded no version yet" }
  }
  $disk = Get-AddOnVersion
  $v = $recorded
  if ($disk) { $v = Get-LowerVersion @($recorded, $disk); $how += "; AddOns\ChartBridge.cs says $disk" }
  return @{ version = $v; source = 'recorded'; detail = "$how; counting $v ($($diag.detail))" }
}

# ------------------------------------------------------------------------------------------------ a commit's files

function Test-Manifest($M) {
  if (-not ($M -is [System.Collections.IDictionary])) { throw 'install-files.json is not an object' }
  $addons = @(Get-Field $M 'addons' @())
  $www = @(Get-Field $M 'www' @())
  if ($addons.Count -eq 0 -or $www.Count -eq 0) { throw 'install-files.json lists no add-on or no page files' }
  foreach ($a in $addons) {
    if (-not ($a -is [string]) -or $a -notmatch '^nt8/[A-Za-z0-9_.-]+\.cs$') { throw "add-on entry '$a' must be nt8/<name>.cs" }
  }
  foreach ($w in $www) {
    $from = [string](Get-Field $w 'from' ''); $to = [string](Get-Field $w 'to' '')
    if (-not $from -or -not $to) { throw 'a page entry needs from and to' }
    if ($to -notmatch $script:TargetPattern) { throw "page target '$to' must be a plain path inside www (letters, digits, - and _, dotted names)" }
    if ($to -match '\.cs$' -or $from -match '\.cs$') { throw "page entry '$to' may not be a .cs file" }
    if ($to -eq $script:VersionFile) { throw "page entry '$to' is the updater's own file" }
  }
}

# What a commit holds, read from git objects (the working tree is never needed).
function Get-CommitInfo([string]$Sha) {
  $m = Invoke-Git @('show', "${Sha}:$($script:ManifestPath)") 60
  if ($m.code -ne 0) { throw "$(Get-Short $Sha) has no $($script:ManifestPath) (older than the updater)" }
  $c = Invoke-Git @('show', "${Sha}:$($script:CompatPath)") 60
  if ($c.code -ne 0) { throw "$(Get-Short $Sha) has no $($script:CompatPath)" }
  $cb = Invoke-Git @('show', "${Sha}:nt8/ChartBridge.cs") 60
  if ($cb.code -ne 0) { throw "$(Get-Short $Sha) has no nt8/ChartBridge.cs" }
  $self = Invoke-Git @('cat-file', '-e', "${Sha}:$($script:SelfPath)") 60
  if ($self.code -ne 0) { throw "$(Get-Short $Sha) has no $($script:SelfPath)" }
  $manifest = ConvertFrom-JsonText $m.out
  Test-Manifest $manifest
  $compat = ConvertFrom-JsonText $c.out
  $min = [string](Get-Field $compat 'minChartBridge' '')
  $pageV = [string](Get-Field $compat 'page' '')
  if (-not (ConvertTo-VersionOrNull $min)) { throw "$($script:CompatPath) at $(Get-Short $Sha) has no minChartBridge version" }
  $vm = [regex]::Match($cb.out, 'public const string Version = "([^"]+)"')
  if (-not $vm.Success -or -not (ConvertTo-VersionOrNull $vm.Groups[1].Value)) { throw "no Version in nt8/ChartBridge.cs at $(Get-Short $Sha)" }
  return @{ commit = $Sha; manifest = $manifest; pageVersion = $pageV; minChartBridge = $min; chartBridgeVersion = $vm.Groups[1].Value }
}

# Stage a commit's files under updater\staged: page\ (laid out as www) and addons\ (the .cs files, which only
# -InstallChartBridge copies). Built in staged.tmp and then renamed, so staged\ is always one whole commit.
function Invoke-Stage($Info) {
  $current = Read-JsonFile (Join-Path $script:P.Staged 'stage.json')
  if ($current -and (Get-Field $current 'commit') -eq $Info.commit -and (Test-StagedIntact $current)) { return $current }
  $tmp = Join-Path $script:P.Dir 'staged.tmp'
  Remove-Dir $tmp
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $addons = @(Get-Field $Info.manifest 'addons' @())
  $www = @(Get-Field $Info.manifest 'www' @())
  $paths = @($addons) + @($www | ForEach-Object { [string](Get-Field $_ 'from') }) + @($script:SelfPath) | Select-Object -Unique
  $zip = Join-Path $tmp 'files.zip'
  $r = Invoke-Git (@('archive', '--format=zip', '-o', $zip, $Info.commit) + $paths) 120
  if ($r.code -ne 0) { throw "git archive failed: $(Get-LastLine $r.err)" }
  $src = Join-Path $tmp 'src'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $src)
  Remove-FileRetry $zip
  $targets = @()
  foreach ($w in $www) {
    $from = Get-LocalPath $src ([string](Get-Field $w 'from'))
    $to = [string](Get-Field $w 'to')
    $dest = Get-LocalPath (Join-Path $tmp 'page') $to
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Copy-Item -LiteralPath $from -Destination $dest -Force
    $targets += $to
  }
  $names = @()
  New-Item -ItemType Directory -Force -Path (Join-Path $tmp 'addons') | Out-Null
  foreach ($a in $addons) {
    $leaf = Split-Path -Leaf $a
    Copy-Item -LiteralPath (Get-LocalPath $src $a) -Destination (Join-Path (Join-Path $tmp 'addons') $leaf) -Force
    $names += $leaf
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $tmp 'bin') | Out-Null     # this updater, for -InstallChartBridge
  Copy-Item -LiteralPath (Get-LocalPath $src $script:SelfPath) -Destination (Join-Path (Join-Path $tmp 'bin') 'update-pc.ps1') -Force
  Remove-Dir $src
  # the add-on files and this updater, byte for byte what the commit holds (git blob ids), then their sha256 for later
  $blobs = Get-CommitBlobs $Info.commit (@($addons) + @($script:SelfPath))
  $sums = @{}
  foreach ($a in $addons) {
    $f = Join-Path (Join-Path $tmp 'addons') (Split-Path -Leaf $a)
    if (-not $blobs.Contains($a) -or (Get-BlobId $f $a) -ne $blobs[$a]) { throw "the staged $a does not match $(Get-Short $Info.commit)" }
    $sums["addons/$(Split-Path -Leaf $a)"] = Get-FileSha256 $f
  }
  $f = Join-Path (Join-Path $tmp 'bin') 'update-pc.ps1'
  if (-not $blobs.Contains($script:SelfPath) -or (Get-BlobId $f $script:SelfPath) -ne $blobs[$script:SelfPath]) { throw "the staged updater does not match $(Get-Short $Info.commit)" }
  $sums['bin/update-pc.ps1'] = Get-FileSha256 $f
  $stage = @{
    commit = $Info.commit; pageVersion = $Info.pageVersion; minChartBridge = $Info.minChartBridge
    chartBridgeVersion = $Info.chartBridgeVersion; pageFiles = $targets; addonFiles = $names
    build = (Get-BuildId (Join-Path $tmp 'page') $targets); stagedAt = (Get-NowMs)
    sha256 = $sums; updaterBlob = $blobs[$script:SelfPath]
  }
  Write-JsonAtomic (Join-Path $tmp 'stage.json') $stage
  $old = Join-Path $script:P.Dir 'staged.old'
  Remove-Dir $old
  if (Test-Path $script:P.Staged) { [IO.Directory]::Move($script:P.Staged, $old) }
  [IO.Directory]::Move($tmp, $script:P.Staged)
  Remove-Dir $old
  Write-Log "staged $(Get-Short $Info.commit): page $($Info.pageVersion) (build $($stage.build)), ChartBridge $($Info.chartBridgeVersion)"
  return $stage
}

function Test-StagedIntact($Stage) {
  $page = Join-Path $script:P.Staged 'page'
  if ((Get-BuildId $page @(Get-Field $Stage 'pageFiles' @())) -ne (Get-Field $Stage 'build')) { return $false }
  $sums = Get-Field $Stage 'sha256'
  if (-not ($sums -is [System.Collections.IDictionary])) { return $false }
  foreach ($n in @(@(Get-Field $Stage 'addonFiles' @()) | ForEach-Object { "addons/$_" }) + @('bin/update-pc.ps1')) {
    $f = Get-LocalPath $script:P.Staged $n
    if (-not (Test-Path -LiteralPath $f) -or -not $sums.Contains($n) -or (Get-FileSha256 $f) -ne $sums[$n]) { return $false }
  }
  return $true
}

# ------------------------------------------------------------------------------------------------ the page files

function Get-ManagedFiles($State, $Extra) {
  $list = @(Get-Field $State['page'] 'files' @()) + @($Extra) | Where-Object { $_ } | Select-Object -Unique
  return @($list)
}

# Is www exactly the build state.json says is installed (every managed file, every byte)? Only then is it copied as
# the rollback copy: a www changed by hand, or left mixed, is never kept as "previous".
function Test-WwwKnown($State) {
  $b = Get-Field $State['page'] 'build'
  if (-not $b) { return $false }
  return ((Get-BuildId $script:P.Www @(Get-Field $State['page'] 'files' @())) -eq $b)
}

# Tests only: a place where a run can be cut off (power loss, a laptop lid). Does nothing in a real run.
function Invoke-CrashPoint([string]$Name) { }

# Copy the page files now in www (the ones this tool manages) into a folder, for a rollback.
function Save-PageCopy([string]$Dest, [string[]]$Files, $Meta) {
  $tmp = "$Dest.tmp"
  Remove-Dir $tmp
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $kept = @()
  foreach ($f in $Files) {
    $from = Get-LocalPath $script:P.Www $f
    if (Test-Path -LiteralPath $from) {
      $to = Get-LocalPath (Join-Path $tmp 'page') $f
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
      Copy-Item -LiteralPath $from -Destination $to -Force
      $kept += $f
    }
  }
  $Meta['files'] = $kept
  $Meta['build'] = Get-BuildId (Join-Path $tmp 'page') $kept
  $Meta['savedAt'] = Get-NowMs
  Write-JsonAtomic (Join-Path $tmp 'previous.json') $Meta
  return $tmp
}

function Complete-PageCopy([string]$Tmp, [string]$Dest) {
  $old = "$Dest.old"
  Remove-Dir $old
  if (Test-Path $Dest) { [IO.Directory]::Move($Dest, $old) }
  [IO.Directory]::Move($Tmp, $Dest)
  Remove-Dir $old
}

# A folder swap cut off between its two renames leaves <dir>.old and no <dir>: put it back.
function Repair-Folders {
  foreach ($d in @($script:P.Previous, $script:P.Staged)) {
    if (-not (Test-Path $d) -and (Test-Path "$d.old")) { [IO.Directory]::Move("$d.old", $d); Write-Log "put $d back after an interrupted run" 'WARN' }
  }
}

# The order files are written in: what others load first (the engine, then the libraries and styles), live.js after
# them, then what loads live.js (the workspace's script), the pages, and index.html last. A page loaded in the middle
# then gets old files with new dependencies, never the reverse.
function Get-PageOrder([string[]]$Files) {
  $rank = {
    param($f)
    if ($f -eq 'index.html') { return 9 }
    if ($f -like '*.html') { return 8 }
    if ($f -eq 'live.js') { return 6 }
    if ($f -eq 'update-notice.js' -or $f -eq 'workspace.js') { return 7 }
    if ($f -like 'src/*') { return 0 }
    if ($f -like '*.js') { return 1 }
    if ($f -like '*.css') { return 2 }
    return 3
  }
  return @($Files | Sort-Object @{ Expression = { & $rank $_ } }, @{ Expression = { $_ } })
}

# Write page files into www one by one: each through <name>.upd-tmp and an atomic replace, in Get-PageOrder's order.
function Copy-PageFiles([string]$FromRoot, [string[]]$Files, [string[]]$Drop) {
  $root = [IO.Path]::GetFullPath($script:P.Www).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $i = 0
  foreach ($f in (Get-PageOrder $Files)) {
    if ($f -notmatch $script:TargetPattern) { throw "page target '$f' refused" }
    $dest = [IO.Path]::GetFullPath((Get-LocalPath $script:P.Www $f))
    if (-not $dest.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw "page target '$f' is outside www" }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    $tmp = "$dest.upd-tmp"
    Copy-Item -LiteralPath (Get-LocalPath $FromRoot $f) -Destination $tmp -Force
    Move-FileAtomic $tmp $dest
    $i++
    Invoke-CrashPoint "file:$i"
  }
  foreach ($f in @($Drop)) {
    if ($f -and $Files -notcontains $f -and $f -match $script:TargetPattern) {
      $p = Get-LocalPath $script:P.Www $f
      if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
    }
  }
}

# A page swap with a journal (updater\swap.json), written before the first file in www changes:
#   target  the build to install: its files, where they come from (staged\page or previous\page), commit, version
#   back    a complete build to go back to (previous\page), when there is one
#   then    'promote': after a rollback, previous-next becomes previous
#   skip    a commit to skip from now on (a rollback)
# Resume-Swap at the start of every run finishes it (the target's source is still intact) or undoes it (back).
function Invoke-Swap($State, $Target, $Back, [string]$Then, [string]$Skip) {
  $j = @{ startedAt = (Get-NowMs); target = $Target; back = $Back; then = $Then; skip = $Skip; old = $State['page'] }
  Write-JsonAtomic $script:P.Journal $j
  Invoke-CrashPoint 'after-journal'
  # open pages learn at once that files change under them (and a page that loads now may get some of each)
  Write-UpdatePage @{ version = $Target.version; build = $Target.build; commit = $Target.commit; installedAt = (Get-NowMs) } 'installing'
  $drop = @(Get-ManagedFiles $State @()) + @(Get-Field $Back 'files' @())
  Copy-PageFiles $Target.source @($Target.files) $drop
  Invoke-CrashPoint 'after-files'
  Complete-Swap $State $j 'installed'
}

function Complete-Swap($State, $J, [string]$How) {
  $t = $J['target']
  $page = @{ commit = $t['commit']; version = $t['version']; build = $t['build']; files = @($t['files']); installedAt = (Get-NowMs); how = $How }
  # every file's hash checked again: only a www that is exactly the new build is called installed. The page is told
  # before state.json is saved, so a run cut off from here on leaves "installed" (which the files are), never a
  # stale "installing" that reads as "cut off"; the next run closes the journal.
  if ((Get-BuildId $script:P.Www @($t['files'])) -ne $t['build']) { throw "www is not the build $($t['build']) after the copy; not recorded as installed" }
  try { Write-UpdatePage $page '' } catch { Write-Log "update.json could not be written now ($($_.Exception.Message)); the end of this run writes it" 'WARN' }
  $State['page'] = $page
  if ($J['skip']) { $State['skipCommit'] = $J['skip'] }
  Save-State $State
  Invoke-CrashPoint 'after-state'
  if ($J['then'] -eq 'promote' -and (Test-Path "$($script:P.PrevNext).tmp")) { Complete-PageCopy "$($script:P.PrevNext).tmp" $script:P.Previous }
  Remove-Item -LiteralPath $script:P.Journal -Force
}

function Undo-Swap($State, $J) {
  $b = $J['back']
  if (-not $b -or (Get-BuildId $b['source'] @($b['files'])) -ne $b['build']) { return $false }
  Copy-PageFiles $b['source'] @($b['files']) @(@($J['target']['files']) + @(Get-ManagedFiles $State @()))
  $State['page'] = @{ commit = $b['commit']; version = $b['version']; build = $b['build']; files = @($b['files']); installedAt = (Get-NowMs); how = 'restored after an interrupted install' }
  Save-State $State
  Remove-Dir "$($script:P.PrevNext).tmp"
  Write-UpdatePage $State['page'] ''
  Remove-Item -LiteralPath $script:P.Journal -Force
  return $true
}

# At the start of every run that may write (before pause and every other gate): finish or undo a page swap that was
# cut off. Returns $null (nothing to do), 'finished', 'undone', or throws when neither is possible (www may be mixed).
function Resume-Swap($State) {
  Repair-Folders
  $j = Read-JsonFile $script:P.Journal
  if (-not $j) {
    if (Test-Path $script:P.Journal) { throw "$($script:P.Journal) cannot be read; the page may be mixed: when flat, run update-pc.ps1 repair (page files only)" }
    return $null
  }
  $t = $j['target']
  if ((Get-BuildId $script:P.Www @($t['files'])) -eq $t['build'] -or ((Test-Path $t['source']) -and (Get-BuildId $t['source'] @($t['files'])) -eq $t['build'])) {
    # write what is not yet there, and drop the files the new build no longer has (allow-listed paths only)
    $keep = @($t['files'])
    $drop = @(@(Get-Field $j['back'] 'files' @()) + @(Get-ManagedFiles $State @()) + @(Get-ManagedFiles @{ page = (Get-Field $j 'old' @{}) } @()) | Where-Object { $keep -notcontains $_ })
    if ((Get-BuildId $script:P.Www @($t['files'])) -ne $t['build']) { Copy-PageFiles $t['source'] @($t['files']) $drop }
    else { Copy-PageFiles $t['source'] @() $drop }
    Complete-Swap $State $j 'finished after an interrupted run'
    Write-Log "an interrupted page install was finished: build $($t['build']) ($(Get-Short $t['commit']))" 'WARN'
    return 'finished'
  }
  if (Undo-Swap $State $j) {
    Write-Log "an interrupted page install was undone: back to build $($j['back']['build'])" 'WARN'
    return 'undone'
  }
  Write-UpdatePage @{ version = $null; build = 'interrupted'; commit = $null; installedAt = (Get-NowMs) } 'interrupted'
  throw 'a page install was cut off and neither the new nor the old files are complete on disk: when flat, run update-pc.ps1 repair (it rewrites the page files only, never ChartBridge)'
}

function Install-PageFiles($State, $Stage, [string]$Why) {
  $page = Join-Path $script:P.Staged 'page'
  $files = @(Get-Field $Stage 'pageFiles' @())
  if ((Get-BuildId $page $files) -ne (Get-Field $Stage 'build')) { throw 'the staged page files changed since staging; not installing them' }
  # the rollback copy: only a www that is exactly the installed build (or, the very first time, www as found)
  $hasPrev = Test-Path (Join-Path $script:P.Previous 'previous.json')
  if ((Test-WwwKnown $State) -or (-not (Get-Field $State['page'] 'build') -and -not $hasPrev)) {
    $meta = @{ commit = (Get-Field $State['page'] 'commit'); version = (Get-Field $State['page'] 'version'); known = [bool](Get-Field $State['page'] 'build') }
    $old = @(Get-ManagedFiles $State @())
    if ($old.Count -eq 0) { $old = $files }
    $tmp = Save-PageCopy $script:P.Previous $old $meta
    Complete-PageCopy $tmp $script:P.Previous
  } elseif (Get-Field $State['page'] 'build') {
    Write-Log "www is not the installed build $(Get-Field $State['page'] 'build') (changed by hand?); the kept previous copy stays as it was" 'WARN'
  }
  Invoke-CrashPoint 'after-previous'
  $back = $null
  $prev = Read-JsonFile (Join-Path $script:P.Previous 'previous.json')
  if ($prev -and (Get-BuildId (Join-Path $script:P.Previous 'page') @(Get-Field $prev 'files' @())) -eq (Get-Field $prev 'build')) {
    $back = @{ source = (Join-Path $script:P.Previous 'page'); build = (Get-Field $prev 'build'); files = @(Get-Field $prev 'files' @()); commit = (Get-Field $prev 'commit'); version = (Get-Field $prev 'version') }
  }
  $target = @{ source = $page; build = $Stage.build; files = $files; commit = $Stage.commit; version = $Stage.pageVersion }
  try {
    Invoke-Swap $State $target $back '' ''
  } catch {
    $err = $_.Exception.Message
    Write-Log "page install failed ($err); putting the previous files back" 'ERROR'
    $j = Read-JsonFile $script:P.Journal
    $undone = $false
    if ($j) { try { $undone = Undo-Swap $State $j } catch { $undone = $false } }
    if ($undone) { throw "page install failed and was undone: $err" }
    throw "page install failed ($err); the next run finishes or undoes it"
  }
  $State['page']['how'] = $Why
  Write-Log "page $($Stage.pageVersion) installed from $(Get-Short $Stage.commit) (build $($Stage.build)), $Why"
}

# ------------------------------------------------------------------------------------------------ what the page and The Desk read

function Get-ChartBridgeNotice($State, $Compiled) {
  $stage = Read-JsonFile (Join-Path $script:P.Staged 'stage.json')
  $cbs = $State['chartBridge']
  $inst = Get-Field $cbs 'installed'
  $copied = $null
  if ($inst -and -not (Get-Field $inst 'confirmed' $false)) { $copied = [string](Get-Field $inst 'version') }
  $ready = $null
  $sv = $null
  if ($stage) { $sv = [string](Get-Field $stage 'chartBridgeVersion') }
  $cv = ConvertTo-VersionOrNull ([string]$Compiled.version)
  if ($sv -and $cv -and (ConvertTo-VersionOrNull $sv) -gt $cv -and $sv -ne $copied) { $ready = $sv }
  if ($copied -and $cv -and (ConvertTo-VersionOrNull $copied) -le $cv) { $copied = $null }
  # AddOns holds a mix of new and old ChartBridge files: that alone is said (never "press F5", never "ready")
  $mixed = $null
  if (Get-Field $cbs 'mixed') { $mixed = $true; $copied = $null; $ready = $null }
  return @{ compiled = $Compiled.version; compiledFrom = $Compiled.source; staged = $sv; ready = $ready; copied = $copied; mixed = $mixed }
}

# www\update.json: the page polls it about once a minute. Versions and a build id only (www is served).
#   page.state: '' (installed), 'installing' (files are being replaced now), 'interrupted' (a cut-off install could
#   not be finished or undone).
function Write-UpdateDoc($Page, [string]$PageState, $CbPart) {
  if (-not (Test-Path $script:P.Www)) { return }
  $path = Join-Path $script:P.Www $script:VersionFile
  if ($null -eq $CbPart) {
    $cur = Read-JsonFile $path
    $CbPart = Get-Field $cur 'chartBridge' @{}
    $CbPart = [ordered]@{ compiled = (Get-Field $CbPart 'compiled'); ready = (Get-Field $CbPart 'ready'); copied = (Get-Field $CbPart 'copied'); mixed = (Get-Field $CbPart 'mixed') }
  }
  $doc = [ordered]@{
    schema = 1
    page = [ordered]@{ version = (Get-Field $Page 'version'); build = (Get-Field $Page 'build'); commit = (Get-Field $Page 'commit'); installedAt = (Get-Field $Page 'installedAt' 0); state = $PageState }
    chartBridge = $CbPart
    updater = $null
  }
  if ($script:UpdaterStopped -or (Get-PinnedProblem)) { $doc['updater'] = [ordered]@{ stopped = $true } }   # no path or reason: www is served
  $text = ConvertTo-Json -InputObject $doc -Depth 6
  if ((Test-Path -LiteralPath $path) -and ([IO.File]::ReadAllText($path, $script:Utf8) -eq $text)) { return }
  Write-TextAtomic $path $text
}

function Write-UpdatePage($Page, [string]$PageState) { Write-UpdateDoc $Page $PageState $null }

function Write-UpdateJson($State, $Notice) {
  $cb = [ordered]@{ compiled = $Notice.compiled; ready = $Notice.ready; copied = $Notice.copied; mixed = $Notice.mixed }
  # while a swap is open (cut off, or failed and not undone) the page part says so, never "installed"
  $j = Read-JsonFile $script:P.Journal
  if ($j) {
    $t = $j['target']
    # the files' hashes decide: a www that is already whole is said to be installed, not "installing" (cut off)
    $whole = $false
    try { $whole = (Get-BuildId $script:P.Www @($t['files'])) -eq $t['build'] } catch { }
    $st = 'installing'; if ($whole) { $st = '' }
    Write-UpdateDoc @{ version = $t['version']; build = $t['build']; commit = $t['commit']; installedAt = (Get-Field $j 'startedAt' 0) } $st $cb
    return
  }
  Write-UpdateDoc $State['page'] '' $cb
}

# status.json: one clean record for The Desk to read later (not used yet).
function Write-Status($State, $Result, $Notice) {
  $doc = [ordered]@{
    schema = 1
    updatedAt = (Get-NowMs)
    paused = (Test-Path $script:P.Paused)
    outcome = $Result.outcome
    reason = $Result.reason
    main = [ordered]@{ commit = $Result.target; ci = $Result.ci }
    page = [ordered]@{ version = (Get-Field $State['page'] 'version'); commit = (Get-Field $State['page'] 'commit'); build = (Get-Field $State['page'] 'build'); installedAt = (Get-Field $State['page'] 'installedAt') }
    chartBridge = $Notice
    skipCommit = (Get-Field $State 'skipCommit')
    pendingPage = (Get-Field $State 'pendingPage')
    interrupted = (Test-Path $script:P.Journal)
    alert = $null
    updater = $null
    dailyTrigger = (Get-Field $State 'dailyTrigger')
  }
  if ($Notice.mixed) { $doc['alert'] = $script:MixedStop }
  $pp = Get-PinnedProblem
  if ($pp) { $doc['updater'] = [ordered]@{ stopped = $true; reason = $pp } }
  Write-JsonAtomic $script:P.Status $doc
}

function Show-Toast([string]$Title, [string]$Text) {
  if ($PSVersionTable.PSEdition -eq 'Core' -or $env:OS -ne 'Windows_NT') { return $false }
  try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>' + (& $esc $Title) + '</text><text>' + (& $esc $Text) + '</text></binding></visual></toast>')
    $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show((New-Object Windows.UI.Notifications.ToastNotification $xml))
    return $true
  } catch {
    Write-Log "no Windows notification ($($_.Exception.Message)); the log, status.json and the page say it"
    return $false
  }
}

# ------------------------------------------------------------------------------------------------ one pass

function Test-Preflight([switch]$NoWwwOk) {
  if (-not (Get-GitExe)) { return 'git is not on PATH' }
  if (-not (Test-Path (Join-Path $script:P.Repo '.git'))) { return "$($script:P.Repo) is not a git clone" }
  if (-not (Test-Path $script:P.Nt)) { return "NinjaTrader 8 folder not found at $($script:P.Nt)" }
  if (-not $NoWwwOk -and -not (Test-Path $script:P.Www)) { return "ChartBridge's page folder is missing ($($script:P.Www)): when flat, run update-pc.ps1 -InstallChartBridge (it asks first), press F5, then update-pc.ps1 repair" }
  return $null
}

# The automatic path never moves Anthony's clone (a checkout would put a newer, unannounced ChartBridge.cs where
# nt8\install.ps1 copies from). It fetches origin/main and stages from git objects only.
function Get-CloneBranch {
  $b = Invoke-Git @('symbolic-ref', '-q', '--short', 'HEAD') 30
  if ($b.code -eq 0 -and $b.out.Trim()) { return $b.out.Trim() }
  return 'a detached HEAD'
}

function Get-CloneNote {
  $branch = Get-CloneBranch
  $n = Invoke-Git @('rev-list', '--count', "HEAD..refs/remotes/$($script:Remote)/$($script:Branch)") 30
  $behind = ''; if ($n.code -eq 0 -and $n.out.Trim() -ne '0') { $behind = ", $($n.out.Trim()) commits behind origin/main (git pull when you want; the task does not use the clone's files)" }
  return "on $branch$behind"
}

function New-Result { return @{ outcome = ''; reason = ''; target = $null; ci = $null; stage = $null; compiled = $null; recovered = $null } }

# A git error that says the network is not there (yet), as opposed to a refusal or a broken clone.
function Test-NetworkDown([string]$Err) {
  return [bool]($Err -match "(?i)could not resolve host|failed to connect to|couldn't connect to server|connection timed out|timed out after|network is unreachable|no route to host|temporary failure in name resolution|no such host is known|connection (?:refused|reset)|recv failure")
}

# git fetch of main. With -Wait (the `update` run), a network that is not up yet is waited for: tried again every
# FetchRetrySec for up to FetchWaitSec. Returns the last git result with waitedSec and offline (still no network).
# The path of a file in the clone's git folder (rev-parse --git-path), or null.
function Get-GitPath([string]$Rel) {
  $r = Invoke-Git @('rev-parse', '--git-path', $Rel) 30
  if ($r.code -ne 0) { return $null }
  $p = $r.out.Trim()
  if (-not [IO.Path]::IsPathRooted($p)) { $p = Join-Path $script:P.Repo $p }
  return $p
}

# A fetch that was ended (a timeout, a power cut) can leave a ref lock behind, and every later fetch then fails on it
# (fetch_failed for good). A lock of the refs this updater writes (origin/main, packed-refs), older than StaleLockMinutes
# (far past the fetch's time limit), is removed and logged; a younger one is left (another git may be working) and the
# fetch says why it failed. As botlab_update.ps1's Clear-StaleRefLocks.
function Clear-StaleRefLocks([switch]$ReportOnly) {
  foreach ($rel in @("refs/remotes/$($script:Remote)/$($script:Branch).lock", 'packed-refs.lock')) {
    $lock = Get-GitPath $rel
    if (-not $lock -or -not (Test-Path -LiteralPath $lock)) { continue }
    $age = ((Get-Date) - (Get-Item -LiteralPath $lock).LastWriteTime).TotalMinutes
    if ($age -lt $script:StaleLockMinutes) { Write-Log "a git lock is there ($rel, $([int]$age) min old): left, another git may be working" 'WARN'; continue }
    if ($ReportOnly) { Write-Host "a stale git lock ($rel, $([int]$age) min old) would be removed"; continue }
    try { Remove-Item -LiteralPath $lock -Force; Write-Log "removed a stale git lock ($rel, $([int]$age) min old, left by a fetch that was ended)" 'WARN' }
    catch { Write-Log "a stale git lock ($rel) could not be removed: $($_.Exception.Message)" 'WARN' }
  }
}

function Invoke-Fetch([switch]$Wait, [switch]$DryRun) {
  Clear-StaleRefLocks -ReportOnly:$DryRun
  $start = Get-NowMs
  for ($try = 1; ; $try++) {
    $f = Invoke-Git @('fetch', '--quiet', $script:Remote, $script:Branch) 180
    $waited = [int](((Get-NowMs) - $start) / 1000)
    $down = ($f.code -ne 0) -and (Test-NetworkDown ([string]$f.err))
    # at most FetchWaitSec of waits (by count, and by the clock for fetches that themselves take long)
    if ($f.code -eq 0 -or -not $down -or -not $Wait -or $try * $script:FetchRetrySec -gt $script:FetchWaitSec -or $waited + $script:FetchRetrySec -gt $script:FetchWaitSec) {
      $f.waitedSec = $waited; $f.offline = $down; $f.tries = $try
      return $f
    }
    if ($try -eq 1) {
      Write-Host "the network is not up yet ($(Get-LastLine $f.err)); trying the fetch again for up to $($script:FetchWaitSec) s"
      # a note for a run refused by the lock meanwhile (Get-BusyText): this run is only waiting for the network
      try { [IO.File]::WriteAllText($script:P.NetWait, [string](Get-NowMs), $script:Utf8) } catch { }
    }
    try { Wait-Ms ($script:FetchRetrySec * 1000) } catch { Clear-NetWait; throw }
  }
}
function Clear-NetWait { try { if (Test-Path -LiteralPath $script:P.NetWait) { Remove-Item -LiteralPath $script:P.NetWait -Force } } catch { } }

# What a run refused by the lock says: another run works, or (0.3.8) another run is waiting for the network.
function Get-BusyText {
  try {
    if (Test-Path -LiteralPath $script:P.NetWait) {
      $since = [long]([IO.File]::ReadAllText($script:P.NetWait).Trim())
      $age = ((Get-NowMs) - $since) / 1000
      if ($age -ge 0 -and $age -lt ($script:FetchWaitSec + 240)) {
        return "another update-pc.ps1 run is waiting for the network (the run at sign-in, up to $($script:FetchWaitSec) s; waiting $([int]$age) s so far); try again in about 2 minutes"
      }
    }
  } catch { }
  return 'another update-pc.ps1 run is working; try again in a minute'
}

function Invoke-Pass([switch]$DryRun, [switch]$StageOnly, $State) {
  $r = New-Result
  $pre = Test-Preflight
  if ($pre) { $r.outcome = 'blocked'; $r.reason = $pre; return $r }
  if (-not $DryRun) {
    # first of all, before pause and every other gate: a page install that was cut off is finished or undone
    try { $res = Resume-Swap $State } catch { $r.outcome = 'interrupted'; $r.reason = $_.Exception.Message; return $r }
    if ($res) { $r.recovered = $res }
  }
  if (-not $DryRun -and -not $StageOnly -and (Test-Path $script:P.Paused)) {
    $r.compiled = Get-CompiledChartBridge $State
    $r.outcome = 'paused'; $r.reason = "paused by hand ($($script:P.Paused)); run update-pc.ps1 resume to turn updates back on"; return $r
  }
  $r.compiled = Get-CompiledChartBridge $State
  try { $f = Invoke-Fetch -Wait:(-not $DryRun -and -not $StageOnly) -DryRun:$DryRun } finally { if (-not $DryRun -and -not $StageOnly) { Clear-NetWait } }
  if ($f.code -ne 0 -and $f.offline) {
    # 0.3.8: quietly (not a stop): nothing was changed, and the next run (sign-in or the daily one) tries again
    $r.outcome = 'offline'; $r.reason = "the network was not up: git fetch could not reach $($script:Remote) ($($f.tries) tries over $($f.waitedSec) s; $(Get-LastLine $f.err)); nothing changed, the next run tries again"
    return $r
  }
  if ($f.code -ne 0) { $r.outcome = 'fetch_failed'; $r.reason = "git fetch failed: $(Get-LastLine $f.err)"; return $r }
  $t = Invoke-Git @('rev-parse', "refs/remotes/$($script:Remote)/$($script:Branch)") 30
  if ($t.code -ne 0) { $r.outcome = 'fetch_failed'; $r.reason = "no $($script:Remote)/$($script:Branch)"; return $r }
  $r.target = $t.out.Trim()
  $short = Get-Short $r.target
  if ($r.target -eq (Get-Field $State 'skipCommit')) {
    $r.outcome = 'held'; $r.reason = "$short was rolled back by hand; waiting for a newer commit on main"; return $r
  }
  if (@($State['ciGreen']) -contains $r.target) { $ci = @{ state = 'success'; detail = 'green (remembered)' } }
  else { $ci = Get-CiState (Get-RepoSlug) $r.target }
  $r.ci = $ci.state
  if ($ci.state -ne 'success') {
    $detail = $ci.detail
    if (-not $DryRun -and $ci.state -eq 'pending') {
      $ps = Get-Field $State 'ciPending'
      if (-not $ps -or (Get-Field $ps 'sha') -ne $r.target) { $State['ciPending'] = @{ sha = $r.target; since = (Get-NowMs) } }
      elseif ($detail -like "no '*' result yet" -and (Get-NowMs) - [long](Get-Field $ps 'since' 0) -gt 86400000) {
        $detail = "$detail for over 24 hours: was a required job renamed? (.github/workflows/test.yml; update-pc.ps1 wants $($script:RequiredChecks -join ' and '))"
      }
    }
    $r.outcome = "ci_$($ci.state)"
    $r.reason = "main is at $short; not installing: CI $($ci.state) ($detail)"
    return $r
  }
  if (-not $DryRun) { $State['ciGreen'] = @(@($r.target) + @($State['ciGreen']) | Select-Object -Unique -First 20) }
  try { $info = Get-CommitInfo $r.target } catch { $r.outcome = 'blocked'; $r.reason = $_.Exception.Message; return $r }
  if (-not $DryRun) {
    try { $r.stage = Invoke-Stage $info } catch { $r.outcome = 'stage_failed'; $r.reason = "staging $short failed: $($_.Exception.Message)"; return $r }
  }
  if ($StageOnly) { $r.outcome = 'staged'; $r.reason = "$short staged"; return $r }
  $cv = ConvertTo-VersionOrNull ([string]$r.compiled.version)
  if (-not $cv) {
    $r.outcome = 'cb_unknown'
    $r.reason = "page $($info.pageVersion) at $short not installed: ChartBridge's version on this PC is $($r.compiled.detail). Open NinjaTrader (ChartBridge running) and run update-pc.ps1 status"
    return $r
  }
  if ($cv -lt (ConvertTo-VersionOrNull $info.minChartBridge)) {
    $r.outcome = 'needs_chartbridge'
    $r.reason = "page $($info.pageVersion) at $short needs ChartBridge $($info.minChartBridge); this PC has $($r.compiled.version). When flat: update-pc.ps1 -InstallChartBridge, then F5"
    return $r
  }
  if ($DryRun) {
    $r.outcome = 'would_update'
    $r.reason = "would stage $short and install page $($info.pageVersion) if its files differ from www (ChartBridge $($r.compiled.version) >= $($info.minChartBridge)); ChartBridge in that commit: $($info.chartBridgeVersion) (never installed automatically)"
    return $r
  }
  $wwwBuild = Get-BuildId $script:P.Www @($r.stage.pageFiles)
  if ($wwwBuild -eq $r.stage.build) {
    if ((Get-Field $State['page'] 'build') -ne $r.stage.build -or (Get-Field $State['page'] 'commit') -ne $r.target) {
      $at = 0
      if ((Get-Field $State['page'] 'build') -eq $r.stage.build) { $at = Get-Field $State['page'] 'installedAt' 0 }
      $State['page'] = @{ commit = $r.target; version = $r.stage.pageVersion; build = $r.stage.build; files = @($r.stage.pageFiles); installedAt = $at; how = 'already in www' }
    }
    $r.outcome = 'up_to_date'; $r.reason = "page $($r.stage.pageVersion) (build $($r.stage.build)) is installed; main is at $short"
  } else {
    try { Install-PageFiles $State $r.stage 'automatic update' } catch { $r.outcome = 'install_failed'; $r.reason = $_.Exception.Message; return $r }
    $r.outcome = 'updated'; $r.reason = "page $($r.stage.pageVersion) installed from $short; open pages show 'Update ready: reload when flat'"
  }
  if (Get-Field $State 'pendingPage') { $State.Remove('pendingPage') }
  return $r
}

$script:StopOutcomes = @('blocked', 'fetch_failed', 'ci_unknown', 'stage_failed', 'cb_unknown', 'install_failed', 'interrupted', 'chartbridge_not_copied', 'chartbridge_mixed')

function Complete-Run($State, $Result) {
  $lvl = 'INFO'; if ($script:StopOutcomes -contains $Result.outcome) { $lvl = 'WARN' }
  if ($Result.recovered) { $Result.reason = "(an interrupted page install was $($Result.recovered) first) " + $Result.reason }
  Write-Log "$($Result.outcome): $($Result.reason)" $lvl
  if ($null -eq $Result.compiled) { $Result.compiled = @{ version = $null; source = 'none'; detail = 'not asked' } }
  Update-MixedAddOns $State
  $notice = Get-ChartBridgeNotice $State $Result.compiled
  if ($notice.ready -and (Get-Field $State['chartBridge'] 'toastedFor') -ne $notice.ready) {
    $msg = "ChartBridge $($notice.ready) is ready to install. When flat: update-pc.ps1 -InstallChartBridge, then F5 in the NinjaScript Editor."
    Write-Log $msg
    [void](Show-Toast 'ChartBridge update ready' $msg)
    $State['chartBridge']['toastedFor'] = $notice.ready
  }
  $State['lastRun'] = @{ at = (Get-NowMs); outcome = $Result.outcome; reason = $Result.reason; target = $Result.target }
  Save-State $State
  if ($Result.outcome -ne 'interrupted') { Write-UpdateJson $State $notice }
  Write-Status $State $Result $notice
  return $notice
}

# ------------------------------------------------------------------------------------------------ one run at a time

function Enter-Lock {
  if (-not (Test-Path $script:P.Dir)) { New-Item -ItemType Directory -Force -Path $script:P.Dir | Out-Null }
  try { return [IO.File]::Open($script:P.Lock, 'OpenOrCreate', 'ReadWrite', 'None') } catch { return $null }
}

# ------------------------------------------------------------------------------------------------ commands

function Write-Verdict([bool]$Ok, [string]$Text) {
  if ($Ok) { Write-Host "OK: $Text" } else { Write-Host "STOP: $Text" }
  if ($Ok) { return 0 } return 1
}

function Invoke-Update([switch]$DryRun) {
  $pre = Test-Preflight
  if ($pre) { return (Write-Verdict $false $pre) }      # before anything is written (no NinjaTrader folder: nothing)
  $lock = Enter-Lock
  if (-not $lock) { return (Write-Verdict $false (Get-BusyText)) }
  try {
    $state = Read-State
    if (-not $DryRun) {
      $mig = Invoke-AutoTaskMigration                  # logs its own line (one WARN when refused)
      Save-TriggerCheck $state (Sync-DailyTrigger)
      if (-not $mig) { Write-TaskStartWarning }
    }
    $r = Invoke-Pass -DryRun:$DryRun -State $state
    if ($DryRun) {
      if (Test-Path $script:P.Journal) { Write-Host 'check: a page install was cut off; the next update finishes or undoes it before anything else' }
      Write-Host "check (dry run, nothing changed): $($r.outcome): $($r.reason)"
    } else {
      [void](Complete-Run $state $r)
    }
    return (Write-Verdict ($script:StopOutcomes -notcontains $r.outcome) "$($r.outcome): $($r.reason)")
  } finally { $lock.Dispose() }
}

function Invoke-Status {
  # status saves what /diag reports (so a page waiting for F5 installs on the next run even if NinjaTrader is closed
  # then): the lock first, then state.json, so a run finishing at the same moment never loses its own changes
  $lock = $null; $saved = 'no updater folder yet'
  if (Test-Path $script:P.Dir) { $lock = Enter-Lock; if (-not $lock) { $saved = 'another run is working: what /diag said is not saved this time' } }
  try {
    $state = Read-State
    $c = Get-CompiledChartBridge $state
    if ($lock) { Update-MixedAddOns $state; Save-State $state; $saved = '' }
  } finally { if ($lock) { $lock.Dispose() } }
  $n = Get-ChartBridgeNotice $state $c
  $mx = Get-Field $state['chartBridge'] 'mixed'
  if ($mx) {
    Write-Host '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
    Write-Host "!!  $($script:MixedStop)"
    Write-Host "!!  -InstallChartBridge $(Get-Field $mx 'version') failed half way ($(Get-Field $mx 'error'))."
    Write-Host "!!  Changed from before: $(@(Get-Field $mx 'changed' @()) -join ', '). The files as they were: $(Get-Field $mx 'backup')"
    Write-Host '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
  }
  if ($saved) { Write-Host "note:         $saved" }
  $pg = $state['page']
  Write-Host "clone:        $($script:P.Repo) ($(Get-CloneNote))"
  Write-Host "page folder:  $($script:P.Www)"
  $paused = 'no'; if (Test-Path $script:P.Paused) { $paused = 'YES (update-pc.ps1 resume turns updates back on)' }
  Write-Host "paused:       $paused"
  if (Get-Field $pg 'build') {
    $when = ''; $at = Get-Field $pg 'installedAt' 0
    if ($at) { $when = ', installed ' + [DateTimeOffset]::FromUnixTimeMilliseconds([long]$at).ToLocalTime().ToString('yyyy-MM-dd HH:mm') }
    Write-Host "page:         $(Get-Field $pg 'version') from $(Get-Short (Get-Field $pg 'commit')) (build $(Get-Field $pg 'build')$when)"
  } else { Write-Host 'page:         not installed by this tool yet' }
  Write-Host "ChartBridge:  $(if ($c.version) { $c.version } else { 'unknown' }) ($($c.detail))"
  if ($n.ready) { Write-Host "              ChartBridge $($n.ready) is staged and ready: when flat, update-pc.ps1 -InstallChartBridge, then F5" }
  if ($n.copied) { Write-Host "              ChartBridge $($n.copied) was copied: press F5 in the NinjaScript Editor while flat" }
  $lr = $state['lastRun']
  if (Get-Field $lr 'at') {
    $t0 = [DateTimeOffset]::FromUnixTimeMilliseconds([long](Get-Field $lr 'at')).ToLocalTime()
    Write-Host "last run:     $($t0.ToString('yyyy-MM-dd HH:mm')) ($(Format-Age ([DateTimeOffset]::Now - $t0)) ago), $(Get-Field $lr 'outcome'): $(Get-Field $lr 'reason')"
  } else { Write-Host 'last run:     none recorded yet' }
  if (Get-Field $state 'skipCommit') { Write-Host "skipping:     $(Get-Short (Get-Field $state 'skipCommit')) (rolled back by hand)" }
  if (Get-Field $state 'pendingPage') { Write-Host "page waiting: $(Get-Field $state['pendingPage'] 'version') for ChartBridge $(Get-Field $state['pendingPage'] 'needs') (installs on the first run after F5)" }
  if (Test-Path $script:P.Journal) {
    $j = Read-JsonFile $script:P.Journal
    $whole = $false
    try { $whole = $j -and (Get-BuildId $script:P.Www @($j['target']['files'])) -eq $j['target']['build'] } catch { }
    if ($whole) { Write-Host 'journal:      a page install stopped after every file was written (the hashes match): the page is whole; the next update closes the journal' }
    else { Write-Host 'interrupted:  a page install was cut off; the next update finishes or undoes it first (or, when flat: update-pc.ps1 repair, page files only)' }
  }
  $pin = Read-JsonFile (Join-Path $script:P.Bin 'pinned.json')
  $pp = Get-PinnedProblem
  if ($pp) { Write-Host "task stopped: $pp; the task does nothing until you run register again from the clone" }
  if ($pin) {
    $binFile = Join-Path $script:P.Bin 'update-pc.ps1'
    $okPin = (Test-Path $binFile) -and (Get-FileSha256 $binFile) -eq (Get-Field $pin 'sha256')
    Write-Host "task runs:    $binFile (from $(Get-Short (Get-Field $pin 'commit')), $(Get-Field $pin 'from'))$(if (-not $okPin) { ' CHANGED since it was pinned: run register again' })"
    if ([IO.Path]::GetFullPath($script:UpdaterSelf) -ne [IO.Path]::GetFullPath($binFile) -and $okPin -and (Get-FileSha256 $script:UpdaterSelf) -ne (Get-Field $pin 'sha256')) {
      Write-Host '              (this is the clone''s copy, not the one the task runs; README "Keep this PC up to date" shows how to run that one)'
    }
  }
  if ($env:OS -eq 'Windows_NT') {
    try {
      $pol = @(Get-ExecutionPolicy -List | Where-Object { "$($_.ExecutionPolicy)" -ne 'Undefined' } | ForEach-Object { "$($_.Scope)=$($_.ExecutionPolicy)" })
      Write-Host "exec policy:  $(if ($pol.Count) { $pol -join ', ' } else { 'none set' }) (a MachinePolicy or UserPolicy of AllSigned stops the task)"
    } catch { }
  }
  Write-Host "log:          $($script:P.Log)"
  $task = $null
  if ($env:OS -eq 'Windows_NT') { $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  Write-Host "task:         $(if ($task) { "$TaskName ($($task.State))" } else { 'not registered (update-pc.ps1 register)' })"
  $start = $null; $run = $null
  if ($task) {
    $start = Test-TaskStart $task 'update-pc.ps1' { param($o) Get-HiddenLauncherLine (Get-SystemExe 'System32\WindowsPowerShell\v1.0\powershell.exe') (Get-TaskArguments (Join-Path $script:P.Bin 'update-pc.ps1') ([string]$o['Repo'])) } $script:OwnParams
    Write-Host "task start:   $($start.text)"
    if ($start.line) { Write-Host "task command: $($start.line)" }
    $run = Get-TaskRunState $task $start.line
    foreach ($l in $run.lines) { Write-Host $l }
    try { foreach ($l in @(Get-DailyLines $task @(Get-PinTimes $pin))) { Write-Host "daily check:  $l" } }
    catch { Write-Host "daily check:  cannot be worked out ($($_.Exception.Message))" }
  }
  $dt = Get-Field $state 'dailyTrigger'
  if ($dt -and (Get-Field $dt 'note' '')) { Write-Host "daily check:  the last run left them alone: $(Get-Field $dt 'note')" }
  if ($dt -and -not (Get-Field $dt 'ok' $true)) {
    $since = [DateTimeOffset]::FromUnixTimeMilliseconds([long](Get-Field $dt 'failingSince' 0)).ToLocalTime().ToString('yyyy-MM-dd HH:mm')
    $last = [DateTimeOffset]::FromUnixTimeMilliseconds([long](Get-Field $dt 'failedAt' 0)).ToLocalTime().ToString('yyyy-MM-dd HH:mm')
    Write-Host "daily check:  the last move FAILED at $last (failing since $since): $(Get-Field $dt 'error'). If the task was registered from an elevated window, run register again from a normal (not elevated) PowerShell window"
  }
  $pre = Test-Preflight
  if ($pre) { return (Write-Verdict $false $pre) }
  if ($mx) { return (Write-Verdict $false $script:MixedStop) }
  if ($pp) { return (Write-Verdict $false "the task's updater is stopped: $pp. Run update-pc.ps1 register from the clone") }
  if ($start -and -not $start.ok) { return (Write-Verdict $false "the task's start: $($start.text)") }
  if ($run -and $run.stop) { return (Write-Verdict $false $run.stop) }
  if (-not $c.version) { return (Write-Verdict $false "ChartBridge's version is not known: open NinjaTrader so ChartBridge runs, then run status again") }
  return (Write-Verdict $true "ChartBridge $($c.version) ($($c.source))")
}

# status (1.39.1, the hidden-register review): the task as Task Scheduler keeps it, not as this window sees its own files.
#   - Disabled: no run starts at all (STOP).
#   - Its last run: when, and Task Scheduler's LastTaskResult in words; a result that means the run did not start or broke
#     (a launcher or a PowerShell that could not start, an access error) is a STOP; 1 is the updater's own STOP (update.log).
#   - Its own state folder: the pinned copy it runs sits in <updater>\bin, so its state is <updater>. When that is not
#     this window's (another user's Documents, a Documents folder moved by OneDrive), the task's last run is read from its
#     own state.json and said, with both folders.
# @{ lines; stop ('' or the STOP text) }. $Info: Get-ScheduledTaskInfo's answer (the tests pass one).
function Get-TaskRunState($Task, [string]$Line, $Info = $null) {
  $r = @{ lines = @(); stop = '' }
  if (-not $Task) { return $r }
  if ("$($Task.State)" -eq 'Disabled') { $r.stop = "the scheduled task '$TaskName' is Disabled: no update runs. Enable it in Task Scheduler, or run update-pc.ps1 register" }
  if ($null -eq $Info) { try { $Info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop } catch { $r.lines += "task last:    cannot be read ($($_.Exception.Message))" } }
  if ($null -ne $Info) {
    $code = $null; try { $code = [int64]$Info.LastTaskResult } catch { }
    $when = $null; try { if ($Info.LastRunTime) { $when = [datetime]$Info.LastRunTime } } catch { }
    $never = $null -eq $when -or $when.Year -lt 2000 -or $code -eq 267011
    $words = Get-TaskResultText $code
    if ($never) { $r.lines += 'task last:    no run yet' }
    else { $r.lines += "task last:    $($when.ToString('yyyy-MM-dd HH:mm')), result $(Format-TaskResult $code) ($($words.text))" }
    if (-not $never -and $words.bad -and -not $r.stop) { $r.stop = "the task's last run ($($when.ToString('yyyy-MM-dd HH:mm'))) ended with $(Format-TaskResult $code): $($words.text)" }
  }
  $o = $null; if ($Line) { $o = Get-CommandOptions $Line 'update-pc.ps1' $script:OwnParams }
  $sp = if ($null -ne $o) { [string]$o['#script'] } else { '' }
  if ($sp -and (Split-Path -Leaf (Split-Path -Parent $sp)) -eq 'bin') {
    $dir = Split-Path -Parent (Split-Path -Parent $sp)
    if (-not (Test-SamePath $dir $script:P.Dir)) {
      $r.lines += "task state:   the task keeps its state in $dir; this window reads $($script:P.Dir) (another user's or another Documents folder)"
      $st = Read-JsonFile (Join-Path $dir 'state.json')
      $lr = Get-Field $st 'lastRun'
      if (Get-Field $lr 'at') {
        $t0 = [DateTimeOffset]::FromUnixTimeMilliseconds([long](Get-Field $lr 'at')).ToLocalTime()
        $r.lines += "              its last run there: $($t0.ToString('yyyy-MM-dd HH:mm')), $(Get-Field $lr 'outcome'): $(Get-Field $lr 'reason')"
      } else { $r.lines += "              its state.json there: $(if (Test-Path -LiteralPath (Join-Path $dir 'state.json')) { 'no run recorded' } else { 'none (it cannot be read from here, or the task has not run)' })" }
    }
  }
  return $r
}
function Format-TaskResult($Code) {
  if ($null -eq $Code) { return 'unknown' }
  if ($Code -ge 0 -and $Code -le 255) { return "$Code" }
  return ('0x{0:X8}' -f ([int64]$Code -band 4294967295))
}
# Task Scheduler's LastTaskResult in words; bad: the run did not start or broke (status ends with STOP)
function Get-TaskResultText($Code) {
  if ($null -eq $Code) { return @{ text = 'not known'; bad = $false } }
  $u = [int64]$Code -band 4294967295
  # decimal (Windows PowerShell 5.1 reads a hex literal over 0x7FFFFFFF as a negative Int32): 0x41301 to 0x41306, SCHED_S_*;
  # 0x8004131F SCHED_E_ALREADY_RUNNING; 0x80070002 file not found; 0x80070005 access denied; 0x800710E0 refused; 0xC000013A
  switch ($u) {
    0 { return @{ text = 'finished, OK'; bad = $false } }
    1 { return @{ text = 'the updater said STOP; update.log says why'; bad = $false } }
    267009 { return @{ text = 'running now'; bad = $false } }
    267010 { return @{ text = 'the task is disabled'; bad = $true } }
    267011 { return @{ text = 'it has not run yet'; bad = $false } }
    267014 { return @{ text = 'ended by Task Scheduler or by hand (its 30 minute limit?)'; bad = $false } }
    2147750687 { return @{ text = 'it was still running, so this start was skipped'; bad = $false } }
    2147942402 { return @{ text = 'a file it starts was not found (the launcher or the pinned copy): run update-pc.ps1 register'; bad = $true } }
    2147942405 { return @{ text = 'access denied: run update-pc.ps1 register from a normal window'; bad = $true } }
    2147946720 { return @{ text = 'the operator or administrator refused the request (not signed in, or the task is not allowed to start)'; bad = $true } }
    3221225786 { return @{ text = 'stopped (the window or the session closed)'; bad = $false } }
  }
  return @{ text = 'the run failed; see update.log and the task''s History in Task Scheduler'; bad = $true }
}

function Invoke-Rollback {
  $pre = Test-Preflight
  if ($pre) { return (Write-Verdict $false $pre) }
  $lock = Enter-Lock
  if (-not $lock) { return (Write-Verdict $false (Get-BusyText)) }
  try {
    $state = Read-State
    try { [void](Resume-Swap $state) } catch { return (Write-Verdict $false $_.Exception.Message) }
    $prev = Read-JsonFile (Join-Path $script:P.Previous 'previous.json')
    if (-not $prev -or @(Get-Field $prev 'files' @()).Count -eq 0) { return (Write-Verdict $false 'no previous page files are kept yet; nothing to roll back to') }
    $pfiles = @(Get-Field $prev 'files' @())
    if ((Get-BuildId (Join-Path $script:P.Previous 'page') $pfiles) -ne (Get-Field $prev 'build')) { return (Write-Verdict $false 'the kept previous files do not match their record; nothing changed') }
    $cur = $state['page']
    $rolledFrom = Get-Field $cur 'commit'
    $back = $null; $then = ''
    Remove-Dir "$($script:P.PrevNext).tmp"
    if (Test-WwwKnown $state) {
      # what www holds now becomes the next "previous" (rollback again goes forward again)
      $tmp = Save-PageCopy $script:P.PrevNext @(Get-Field $cur 'files' @()) @{ commit = $rolledFrom; version = (Get-Field $cur 'version'); known = $true }
      $back = @{ source = (Join-Path $tmp 'page'); build = (Get-Field $cur 'build'); files = @(Get-Field $cur 'files' @()); commit = $rolledFrom; version = (Get-Field $cur 'version') }
      $then = 'promote'
    }
    $target = @{ source = (Join-Path $script:P.Previous 'page'); build = (Get-Field $prev 'build'); files = $pfiles; commit = (Get-Field $prev 'commit'); version = (Get-Field $prev 'version') }
    $skip = ''; if ($rolledFrom -and $rolledFrom -ne (Get-Field $prev 'commit')) { $skip = $rolledFrom }
    Invoke-Swap $state $target $back $then $skip
    $r = New-Result
    $r.outcome = 'rolled_back'
    $r.reason = "page back to $(Get-Field $prev 'version') ($(Get-Short (Get-Field $prev 'commit'))); $(Get-Short $rolledFrom) is skipped until a newer commit is on main"
    $r.compiled = Get-CompiledChartBridge $state
    [void](Complete-Run $state $r)
    Write-Host 'Open pages keep what they loaded; reload the page when flat. update-pc.ps1 rollback again goes forward again.'
    return (Write-Verdict $true $r.reason)
  } finally { $lock.Dispose() }
}

# The sha256 of each named file in AddOns, 'missing', or 'unreadable' when another program holds it (read only). An
# unreadable file never matches a recorded set, so a mix stays reported instead of the run stopping on the read.
function Get-AddOnHashes([string[]]$Names) {
  $h = @{}
  foreach ($n in $Names) {
    $f = Join-Path $script:P.AddOns $n
    if (Test-Path -LiteralPath $f) {
      try { $h[$n] = Get-FileSha256 $f } catch { $h[$n] = 'unreadable' }
    } else { $h[$n] = 'missing' }
  }
  return $h
}

function Test-SameHashes($A, $B) {
  if (-not ($A -is [System.Collections.IDictionary]) -or -not ($B -is [System.Collections.IDictionary]) -or $A.Count -ne $B.Count) { return $false }
  foreach ($k in @($A.Keys)) { if (-not $B.Contains($k) -or [string]$A[$k] -ne [string]$B[$k]) { return $false } }
  return $true
}

# Copy the staged add-on files into AddOns. All or nothing: if any step fails (a file held past the retry by the
# NinjaScript Editor, antivirus or OneDrive), every file already replaced is put back from the backup, so AddOns is
# exactly as before and the next F5 never compiles a mix of new and old ChartBridge files. Returns
#   @{ ok = $true; backup }                                   all files replaced
#   @{ ok = $false; backup; error; mixed = @() }              nothing changed (AddOns checked against its hashes)
#   @{ ok = $false; backup; error; mixed = @(names); ... }    the restore failed too: AddOns holds a mix
# ChartBridge 0.3.7 (review bars1 N2): the add-on files the previous install had that the staged commit no longer lists
# (a revert of a release that added a file, say ChartBridgeBars.cs). Left in AddOns, NinjaTrader would compile an older
# ChartBridge.cs beside a file that needs a newer one, and no ChartBridge would load. The previous list is the one this
# updater recorded with the install (chartBridge.installed.files); an install recorded before 0.3.7 has none, so it is
# read from that install's commit (its install-files.json). Only ChartBridge*.cs files that are in AddOns now count.
function Get-RetiredAddOns($State, [string[]]$Names) {
  $inst = Get-Field $State['chartBridge'] 'installed'
  $prev = @(Get-Field $inst 'files' @())
  if ($prev.Count -eq 0) {
    $c = [string](Get-Field $inst 'commit' '')
    if ($c -match '^[0-9a-f]{7,40}$') {
      $m = Invoke-Git @('show', "${c}:$($script:ManifestPath)") 60
      if ($m.code -eq 0) {
        try { $prev = @(@(Get-Field (ConvertFrom-JsonText $m.out) 'addons' @()) | ForEach-Object { Split-Path -Leaf ([string]$_) }) } catch { $prev = @() }
      } else { Write-Log "-InstallChartBridge: the installed commit $(Get-Short $c) cannot be read, so files it had that this one drops are not known (none are taken out)" 'WARN' }
    }
  }
  return @($prev | Where-Object { ([string]$_) -match '^ChartBridge[A-Za-z0-9_]*\.cs$' -and $Names -notcontains $_ -and (Test-Path -LiteralPath (Join-Path $script:P.AddOns $_)) } | Select-Object -Unique)
}

function Install-AddOnFiles($Stage, $State) {
  if (-not $script:AddOnWriteAllowed) { throw 'refused: add-on (.cs) files are only copied by update-pc.ps1 -InstallChartBridge, after Anthony confirms he is flat' }
  if (-not (Test-Path $script:P.AddOns)) { New-Item -ItemType Directory -Force -Path $script:P.AddOns | Out-Null }
  $names = @(Get-Field $Stage 'addonFiles' @())
  # files the previous install had and this commit drops: backed up and taken out inside the same all-or-nothing copy
  # (put back with the others when it fails), so AddOns is always one whole set (review bars1 N2)
  $retired = @(Get-RetiredAddOns $State $names)
  $all = @($names) + @($retired)
  $before = Get-AddOnHashes $all
  foreach ($n in $all) { if ($before[$n] -eq 'unreadable') { throw "$n in AddOns cannot be read (another program holds it): nothing was copied, try again" } }
  $keep = [string](Get-Field (Get-Field $State['chartBridge'] 'mixed') 'backup' '')
  $backup = Join-Path $script:P.PrevAddOns ((Get-Date).ToString('yyyyMMdd-HHmmss-fff'))
  for ($i = 2; Test-Path -LiteralPath $backup; $i++) { $backup = Join-Path $script:P.PrevAddOns ((Get-Date).ToString('yyyyMMdd-HHmmss-fff') + "-$i") }
  $replaced = New-Object System.Collections.ArrayList
  $sums = Get-Field $Stage 'sha256' @{}
  $after = @{}
  foreach ($n in $names) { $after[$n] = [string](Get-Field $sums "addons/$n" '') }
  foreach ($n in $retired) { $after[$n] = 'missing' }
  try {
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    foreach ($n in $all) {
      $cur = Join-Path $script:P.AddOns $n
      if (Test-Path -LiteralPath $cur) { Copy-Item -LiteralPath $cur -Destination (Join-Path $backup $n) -Force }
    }
    foreach ($n in $all) {
      if ($before[$n] -ne 'missing' -and (Get-FileSha256 (Join-Path $backup $n)) -ne $before[$n]) { throw "the backup of $n does not match the file in AddOns" }
    }
    # the last three backups, and always the one a recorded mix points to
    Get-ChildItem -Directory $script:P.PrevAddOns | Where-Object { $_.FullName -ne $keep } | Sort-Object Name -Descending | Select-Object -Skip 3 | ForEach-Object { Remove-Dir $_.FullName }
    # all new files first under names NinjaTrader does not compile (.upd-tmp), then the replaces back to back
    foreach ($n in $names) {
      Copy-Item -LiteralPath (Join-Path (Join-Path $script:P.Staged 'addons') $n) -Destination (Join-Path $script:P.AddOns "$n.upd-tmp") -Force
    }
    # recorded before the first replace: a run cut off in the middle (a power loss) is found by the next run, which
    # compares AddOns with the set before and the set after (Update-MixedAddOns)
    $State['chartBridge']['copying'] = @{ at = (Get-NowMs); version = [string](Get-Field $Stage 'chartBridgeVersion'); commit = (Get-Field $Stage 'commit'); files = $all; addonFiles = $names; before = $before; after = $after; backup = $backup }
    Save-State $State
    foreach ($n in $retired) {
      Remove-Item -LiteralPath (Join-Path $script:P.AddOns $n) -Force   # its copy is in the backup
      [void]$replaced.Add($n)
      Write-Log "-InstallChartBridge: $n is not in ChartBridge $(Get-Field $Stage 'chartBridgeVersion')'s file list: taken out of AddOns (kept in $backup)"
      Invoke-CrashPoint "addon:$($replaced.Count)"
    }
    foreach ($n in $names) {
      Move-FileAtomic (Join-Path $script:P.AddOns "$n.upd-tmp") (Join-Path $script:P.AddOns $n)
      [void]$replaced.Add($n)
      Invoke-CrashPoint "addon:$($replaced.Count)"
    }
    return @{ ok = $true; backup = $backup; after = $after; files = $all; retired = $retired }
  } catch {
    $err = $_.Exception.Message
    Write-Log "-InstallChartBridge: the add-on copy failed after $($replaced.Count) of $($all.Count) files ($err); putting back: $(@($replaced) -join ', ')" 'ERROR'
    $notBack = @()
    foreach ($n in @($replaced)) {
      $dest = Join-Path $script:P.AddOns $n
      try {
        if ($before[$n] -eq 'missing') { Remove-Item -LiteralPath $dest -Force }     # it was not there before
        else {
          Copy-Item -LiteralPath (Join-Path $backup $n) -Destination "$dest.upd-restore" -Force
          Move-FileAtomic "$dest.upd-restore" $dest
        }
      } catch { $notBack += $n; Write-Log "-InstallChartBridge: $n could not be put back ($($_.Exception.Message))" 'ERROR' }
    }
    foreach ($n in $all) {
      foreach ($x in @("$n.upd-tmp", "$n.upd-restore")) {
        $f = Join-Path $script:P.AddOns $x
        try { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } } catch { }
      }
    }
    # AddOns is called unchanged only when every file has its hash from before
    $now = $null
    try { $now = Get-AddOnHashes $all } catch { }
    $mixed = @()
    foreach ($n in $all) { if ($null -eq $now -or [string]$now[$n] -ne [string]$before[$n]) { $mixed += $n } }
    return @{ ok = $false; backup = $backup; error = $err; mixed = $mixed; before = $before; after = $after; notBack = $notBack; files = $all }
  }
}

# A mix of new and old ChartBridge files recorded by -InstallChartBridge is cleared once AddOns holds one whole set
# again: every file as before the copy (put back by hand from the backup), or every file of the staged commit.
function Update-MixedAddOns($State) {
  $cp = Get-Field $State['chartBridge'] 'copying'
  if ($cp) {
    # an -InstallChartBridge was cut off during its replaces (it clears this record itself when it ends)
    $State['chartBridge'].Remove('copying')
    $now = Get-AddOnHashes @(Get-Field $cp 'files' @())
    $changed = @(@(Get-Field $cp 'files' @()) | Where-Object { [string]$now[$_] -ne [string](Get-Field (Get-Field $cp 'before') $_) })
    if ($changed.Count -and -not (Test-SameHashes $now (Get-Field $cp 'after')) -and -not (Get-Field $State['chartBridge'] 'mixed')) {
      $cp['changed'] = $changed; $cp['error'] = 'the copy was cut off (a power loss or a closed window?)'
      $State['chartBridge']['mixed'] = $cp
      Write-Log "STOP: $($script:MixedStop). An -InstallChartBridge of ChartBridge $(Get-Field $cp 'version') was cut off half way: $($changed -join ', ') changed. The files as they were: $(Get-Field $cp 'backup')" 'ERROR'
    } elseif ($changed.Count -and (Test-SameHashes $now (Get-Field $cp 'after'))) {
      $State['chartBridge']['installed'] = @{ version = (Get-Field $cp 'version'); commit = (Get-Field $cp 'commit'); at = (Get-NowMs); confirmed = $false; files = @(Get-Field $cp 'addonFiles' (Get-Field $cp 'files' @())) }
      Write-Log "an -InstallChartBridge of ChartBridge $(Get-Field $cp 'version') was cut off after its last replace: all files are in; press F5 when flat" 'WARN'
    }
  }
  $mx = Get-Field $State['chartBridge'] 'mixed'
  if (-not $mx) { return }
  $names = @(Get-Field $mx 'files' @())
  $now = Get-AddOnHashes $names
  if (Test-SameHashes $now (Get-Field $mx 'before')) {
    $State['chartBridge'].Remove('mixed')
    Write-Log 'the ChartBridge files in AddOns are whole again (all as before -InstallChartBridge)'
  } elseif (Test-SameHashes $now (Get-Field $mx 'after')) {
    $State['chartBridge'].Remove('mixed')
    $State['chartBridge']['installed'] = @{ version = (Get-Field $mx 'version'); commit = (Get-Field $mx 'commit'); at = (Get-NowMs); confirmed = $false; files = @(Get-Field $mx 'addonFiles' (Get-Field $mx 'files' @())) }
    Write-Log "the ChartBridge files in AddOns are whole again (all of ChartBridge $(Get-Field $mx 'version'))"
  }
}

$script:MixedStop = 'DO NOT press F5: ChartBridge files are mixed. Run update-pc.ps1 status and report'

function Invoke-InstallChartBridge {
  $pre = Test-Preflight -NoWwwOk
  if ($pre) { return (Write-Verdict $false $pre) }
  $lock = Enter-Lock
  if (-not $lock) { return (Write-Verdict $false (Get-BusyText)) }
  try {
    if (-not (Test-Path $script:P.Www)) { New-Item -ItemType Directory -Force -Path $script:P.Www | Out-Null }   # a PC without the page yet
    $state = Read-State
    $r = Invoke-Pass -StageOnly -State $state
    if ($r.outcome -eq 'interrupted') { return (Write-Verdict $false $r.reason) }
    if ($r.outcome -ne 'staged') { Write-Host "main: $($r.outcome): $($r.reason)" }
    # always from staged\: the CI-green commit that was announced, never from the clone's working tree
    $stage = Read-JsonFile (Join-Path $script:P.Staged 'stage.json')
    if (-not $stage -or -not (Test-StagedIntact $stage)) { return (Write-Verdict $false 'nothing staged from a green commit yet (or the staged files changed); run update-pc.ps1 check to see why') }
    $compiled = Get-CompiledChartBridge $state
    $sv = [string](Get-Field $stage 'chartBridgeVersion')
    $cv = ConvertTo-VersionOrNull ([string]$compiled.version)
    Write-Host "staged:       $(Get-Short (Get-Field $stage 'commit')) (green on main): ChartBridge $sv, page $(Get-Field $stage 'pageVersion')"
    Write-Host "this PC:      ChartBridge $(if ($compiled.version) { $compiled.version } else { 'unknown' }) ($($compiled.detail))"
    if ($cv -and (ConvertTo-VersionOrNull $sv) -lt $cv) {
      Write-Log "-InstallChartBridge: the staged ChartBridge $sv is OLDER than the $($compiled.version) compiled here" 'WARN'
      Write-Host "WARNING: ChartBridge $sv is older than the $($compiled.version) compiled here; this goes back."
    } elseif ($compiled.version -and $compiled.version -eq $sv) { Write-Host "ChartBridge $sv is already compiled here; this copies the same files again." }
    Write-Host ''
    Write-Host 'Before you go on: be flat in every account, and CLOSE the NinjaScript Editor (an open editor compiles as soon as a file changes).'
    if (-not $Yes) {
      $answer = Read-Host "Install ChartBridge $sv now? Type y to go on"
      if ($answer -ne 'y') { return (Write-Verdict $false 'nothing changed') }
    }
    $script:AddOnWriteAllowed = $true
    try { $copy = Install-AddOnFiles $stage $state } finally { $script:AddOnWriteAllowed = $false }
    if ($state['chartBridge'].Contains('copying')) { $state['chartBridge'].Remove('copying') }
    if (-not $copy.ok) { return (Complete-AddOnFailure $state $stage $copy $r $compiled) }
    $backup = $copy.backup
    if (Get-Field $state['chartBridge'] 'mixed') { $state['chartBridge'].Remove('mixed'); Write-Log 'the ChartBridge files in AddOns are one whole set again' }
    # recorded at once: whatever happens next, the notice, status and the F5 bookkeeping know the files were replaced
    $state['chartBridge']['installed'] = @{ version = $sv; commit = (Get-Field $stage 'commit'); at = (Get-NowMs); confirmed = $false; files = @(Get-Field $stage 'addonFiles' @()) }   # 0.3.7: the list, so a later install knows what it drops
    $state['chartBridge']['toastedFor'] = $sv
    Save-State $state
    Write-Log "ChartBridge $sv copied into $($script:P.AddOns) from $(Get-Short (Get-Field $stage 'commit')) by hand (-InstallChartBridge); the files it replaced are in $backup"
    # the scheduled task's own copy of this updater follows the commit Anthony just installed (never an older one)
    $pinNote = ''
    try { $pinNote = Update-PinnedFromStage $stage } catch { $pinNote = "the task's updater was not changed ($($_.Exception.Message))"; Write-Log $pinNote 'WARN' }
    # then the task itself moves to the hidden launcher, once (never stops -InstallChartBridge)
    $migLines = @(Invoke-TaskMigration)
    # the page: now only if it also works with the ChartBridge running until F5 (COMPAT); otherwise after F5
    $pageNote = ''; $pageLater = $false
    $min = ConvertTo-VersionOrNull ([string](Get-Field $stage 'minChartBridge'))
    $waiting = @{ commit = (Get-Field $stage 'commit'); build = (Get-Field $stage 'build'); version = (Get-Field $stage 'pageVersion'); needs = (Get-Field $stage 'minChartBridge') }
    if ((Get-BuildId $script:P.Www @(Get-Field $stage 'pageFiles' @())) -eq (Get-Field $stage 'build')) {
      $pageNote = 'The page is already this commit''s.'
    } elseif ($cv -and $min -and $cv -ge $min) {
      try {
        Install-PageFiles $state $stage 'with ChartBridge (-InstallChartBridge); it works with both'
        $pageNote = "The page $(Get-Field $stage 'pageVersion') was installed too (it works with ChartBridge $($compiled.version) and $sv)."
      } catch {
        $state['pendingPage'] = $waiting; $pageLater = $true
        Write-Log "-InstallChartBridge: the page could not be written now ($($_.Exception.Message)); it follows on the next update" 'WARN'
        $pageNote = "The page could not be written now ($($_.Exception.Message)); it follows on the next update."
      }
    } else {
      $state['pendingPage'] = $waiting; $pageLater = $true
      $pageNote = "The page $(Get-Field $stage 'pageVersion') needs ChartBridge $(Get-Field $stage 'minChartBridge'): it follows on the first update after F5."
    }
    $r2 = New-Result
    $r2.outcome = 'chartbridge_copied'; $r2.reason = "ChartBridge $sv copied; waiting for F5"; $r2.target = $r.target
    $r2.compiled = $compiled
    [void](Complete-Run $state $r2)
    Write-Host ''
    Write-Host "Next, while flat: open the NinjaScript Editor (NinjaTrader > New > NinjaScript Editor) and press F5."
    Write-Host "Then open http://localhost:$(Get-ChartBridgePort)/diag and check that it says ""version"":""$sv"" (or run update-pc.ps1 status)."
    Write-Host $pageNote
    if ($pageLater) { Write-Host 'After F5, run update-pc.ps1 update so the page follows at once (the next scheduled check would do it too).' }
    if ($pinNote) { Write-Host $pinNote }
    foreach ($l in $migLines) { Write-Host $l }
    Write-Host 'Then reload the chart page when flat. The files replaced are kept in:'
    Write-Host "  $backup"
    $tail = ''; if ($pageLater) { $tail = '; the page follows on the next update' }
    return (Write-Verdict $true "ChartBridge $sv copied: open the NinjaScript Editor and press F5 while flat$tail")
  } finally { $lock.Dispose() }
}

# -InstallChartBridge could not copy every add-on file. Nothing changed (every replaced file was put back): say so and
# stop. The put-back failed too: AddOns holds new and old ChartBridge files, and the next F5 would compile that mix on
# the order path. That is recorded, and said on the console, in update.log, status.json and on the page, until
# AddOns holds one whole set again.
function Complete-AddOnFailure($State, $Stage, $Copy, $Pass, $Compiled) {
  $sv = [string](Get-Field $Stage 'chartBridgeVersion')
  $r2 = New-Result
  $r2.target = $Pass.target; $r2.compiled = $Compiled
  $old = Get-Field $State['chartBridge'] 'mixed'
  if (@($Copy.mixed).Count -eq 0) {
    $r2.outcome = 'chartbridge_not_copied'
    $r2.reason = "ChartBridge $sv was not copied and nothing changed in AddOns (every file put back): $($Copy.error). Close the NinjaScript Editor (and anything else holding the file), then run update-pc.ps1 -InstallChartBridge again"
    if ($old) { $r2.reason = "$($script:MixedStop). AddOns still holds the mix from before; this copy of ChartBridge $sv failed too ($($Copy.error)) and changed nothing" }
    [void](Complete-Run $State $r2)
    return (Write-Verdict $false $r2.reason)
  }
  $after = $Copy.after
  $before = $Copy.before; $backup = $Copy.backup
  if ($old) { $before = Get-Field $old 'before'; $backup = [string](Get-Field $old 'backup') }   # the set before the first failed copy
  $State['chartBridge']['mixed'] = @{ at = (Get-NowMs); version = $sv; commit = (Get-Field $Stage 'commit'); files = @($(if ($Copy.files) { $Copy.files } else { Get-Field $Stage 'addonFiles' @() })); addonFiles = @(Get-Field $Stage 'addonFiles' @()); before = $before; after = $after; backup = $backup; changed = @($Copy.mixed); error = $Copy.error }
  $r2.outcome = 'chartbridge_mixed'
  $r2.reason = "$($script:MixedStop). The copy of ChartBridge $sv failed ($($Copy.error)) and the old files could not all be put back: $(@($Copy.mixed) -join ', ') differ from before. The files as they were before are in $backup"
  Write-Log "STOP: $($r2.reason)" 'ERROR'
  [void](Complete-Run $State $r2)
  Write-Host ''
  Write-Host '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
  Write-Host "!!  $($script:MixedStop)"
  Write-Host "!!  Changed from before: $(@($Copy.mixed) -join ', '). The files as they were: $backup"
  Write-Host '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
  Write-Host ''
  return (Write-Verdict $false $r2.reason)
}

# update-pc.ps1 repair (page files only, never ChartBridge): finish or undo a cut-off install; if neither is possible,
# write a whole page from staged\ (when it works with the ChartBridge here), else previous\, else the clone's page
# files (the www part of its install-files.json only), through the same journaled swap.
function Invoke-Repair {
  $pre = Test-Preflight -NoWwwOk
  if ($pre) { return (Write-Verdict $false $pre) }
  $lock = Enter-Lock
  if (-not $lock) { return (Write-Verdict $false (Get-BusyText)) }
  try {
    if (-not (Test-Path $script:P.Www)) { New-Item -ItemType Directory -Force -Path $script:P.Www | Out-Null }
    $state = Read-State
    $err = ''
    try { $res = Resume-Swap $state; if ($res) { return (Write-Verdict $true "the cut-off page install was $res") } } catch { $err = $_.Exception.Message }
    if (-not $err -and (Test-WwwKnown $state)) { return (Write-Verdict $true "nothing to repair: www is the installed build $(Get-Field $state['page'] 'build')") }
    $compiled = Get-CompiledChartBridge $state
    $cv = ConvertTo-VersionOrNull ([string]$compiled.version)
    $target = $null
    $stage = Read-JsonFile (Join-Path $script:P.Staged 'stage.json')
    if ($stage -and (Get-BuildId (Join-Path $script:P.Staged 'page') @(Get-Field $stage 'pageFiles' @())) -eq (Get-Field $stage 'build') -and $cv -and $cv -ge (ConvertTo-VersionOrNull ([string](Get-Field $stage 'minChartBridge')))) {
      $target = @{ source = (Join-Path $script:P.Staged 'page'); build = (Get-Field $stage 'build'); files = @(Get-Field $stage 'pageFiles' @()); commit = (Get-Field $stage 'commit'); version = (Get-Field $stage 'pageVersion'); from = 'staged' }
    }
    $prev = Read-JsonFile (Join-Path $script:P.Previous 'previous.json')
    if (-not $target -and $prev -and @(Get-Field $prev 'files' @()).Count -and (Get-BuildId (Join-Path $script:P.Previous 'page') @(Get-Field $prev 'files' @())) -eq (Get-Field $prev 'build')) {
      $target = @{ source = (Join-Path $script:P.Previous 'page'); build = (Get-Field $prev 'build'); files = @(Get-Field $prev 'files' @()); commit = (Get-Field $prev 'commit'); version = (Get-Field $prev 'version'); from = 'previous' }
    }
    $compatNote = ''
    if (-not $target) {
      # the clone's page files, laid out as www in a folder of our own (its add-on files are never read), only when its
      # page works with the ChartBridge compiled here (live/COMPAT.json, the same check as the staged page)
      $m = Read-JsonFile (Join-Path (Join-Path $script:P.Repo 'nt8') 'install-files.json')
      Test-Manifest $m
      $head = (Invoke-Git @('rev-parse', 'HEAD') 30).out.Trim()
      $cloneAt = "the clone ($(Get-CloneBranch) at $(Get-Short $head))"
      $min = [string](Get-Field (Read-JsonFile (Join-Path (Join-Path $script:P.Repo 'live') 'COMPAT.json')) 'minChartBridge' '')
      if (-not (ConvertTo-VersionOrNull $min)) { return (Write-Verdict $false "nothing written: staged\ and previous\ cannot be used, and $cloneAt has no readable live/COMPAT.json, so its page cannot be checked against ChartBridge") }
      if ($cv -and $cv -lt (ConvertTo-VersionOrNull $min)) {
        return (Write-Verdict $false "nothing written: staged\ and previous\ cannot be used, and the page in $cloneAt needs ChartBridge $min; this PC has $($compiled.version). Put the clone on main (git checkout main, git pull), or install ChartBridge first (-InstallChartBridge, F5), then run repair again")
      }
      if ($cv) { $compatNote = " It needs ChartBridge $min; this PC has $($compiled.version): checked." }
      else { $compatNote = " NOT checked against ChartBridge: its version here is not known ($($compiled.detail)); this page needs $min. Open NinjaTrader and run update-pc.ps1 status before you reload." }
      $tmp = Join-Path $script:P.Dir 'repair-page'
      Remove-Dir $tmp
      $files = @()
      foreach ($w in @(Get-Field $m 'www' @())) {
        $to = Get-LocalPath $tmp ([string]$w['to'])
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
        Copy-Item -LiteralPath (Get-LocalPath $script:P.Repo ([string]$w['from'])) -Destination $to -Force
        $files += [string]$w['to']
      }
      $target = @{ source = $tmp; build = (Get-BuildId $tmp $files); files = $files; commit = $head; version = ''; from = $cloneAt }
    }
    Write-Log "repair: writing the page from $($target.from) (build $($target.build))$(if ($err) { " after: $err" })" 'WARN'
    Invoke-Swap $state $target $null '' ''
    Remove-Dir (Join-Path $script:P.Dir 'repair-page')
    $r = New-Result
    $r.outcome = 'repaired'; $r.reason = "page files written from $($target.from) (build $($target.build)); ChartBridge untouched"
    $r.compiled = $compiled
    [void](Complete-Run $state $r)
    return (Write-Verdict $true "$($r.reason).$compatNote Reload the page when flat.")
  } finally { $lock.Dispose() }
}

function Invoke-Pause {
  if (-not (Test-Path $script:P.Dir)) { New-Item -ItemType Directory -Force -Path $script:P.Dir | Out-Null }
  [IO.File]::WriteAllText($script:P.Paused, 'paused by hand ' + (Get-Date).ToString('s') + '. Updates wait; a page install that was cut off is still repaired first.' + [Environment]::NewLine, $script:Utf8)
  Write-Log 'paused by hand'
  return (Write-Verdict $true 'paused: the automatic update does nothing until update-pc.ps1 resume')
}

function Invoke-Resume {
  if (Test-Path $script:P.Paused) { Remove-Item -Force $script:P.Paused }
  Write-Log 'resumed by hand'
  return (Write-Verdict $true 'resumed: the next automatic run updates as usual')
}

# The scheduled task: this Windows user, only while signed in (no password stored, no admin). Anthony's ruling
# (2026-09-30): check at startup and on a daily schedule; 2026-10-23: twice a day, at 09:00 and 17:00 New York time.
#   - At sign-in, after two minutes: the "startup" check (an at-startup trigger needs admin or SYSTEM).
#   - One daily trigger per -DailyAt time, New York time (09:00 and 17:00 by default), converted to this PC's clock when
#     registering. A run installs page files only (an open page keeps its loaded code until Anthony reloads it) and never
#     ChartBridge, and the task starts hidden (no window).
#   - No "run as soon as possible after a missed start" (StartWhenAvailable): Task Scheduler would run a missed check
#     whenever the PC is next awake, at any hour. The sign-in trigger already covers a PC that was off; one that slept
#     through the daily time checks the next day.
# Never two runs at once (IgnoreNew, and updater.lock in every run), 30 minutes at most. It runs Windows PowerShell
# with -File, started hidden through wscript.exe //B and the launcher (see "Hidden start" at the top).
function Get-TaskArguments([string]$Script, [string]$RepoDir) {
  return ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + (Format-Arg $Script) + ' update -Repo ' + (Format-Arg $RepoDir))
}

# The copy of this updater the scheduled task runs: updater\bin\update-pc.ps1, always the file of a CI-green commit on
# main (checked against that commit's git blob). It changes only when Anthony runs register or -InstallChartBridge.
# pinned.json keeps its commit, blob, sha256, the clone and the daily times; every run from it checks the sha256.
function Install-PinnedUpdater([string]$Source, [string]$Commit, [string]$Blob, [string]$From) {
  New-Item -ItemType Directory -Force -Path $script:P.Bin | Out-Null
  $dest = Join-Path $script:P.Bin 'update-pc.ps1'
  if ([IO.Path]::GetFullPath($Source) -ne [IO.Path]::GetFullPath($dest)) {
    Copy-Item -LiteralPath $Source -Destination "$dest.upd-tmp" -Force
    Move-FileAtomic "$dest.upd-tmp" $dest
  }
  $old = Read-JsonFile (Join-Path $script:P.Bin 'pinned.json')
  $pin = @{ commit = $Commit; blob = $Blob; from = $From; at = (Get-NowMs); sha256 = (Get-FileSha256 $dest); repo = $script:P.Repo }
  Set-PinTimes $pin @(Get-PinTimes $old)          # the times it had (a pin written before: as Get-PinTimes reads it)
  Write-JsonAtomic (Join-Path $script:P.Bin 'pinned.json') $pin
  Write-Log "the scheduled task's updater is now $dest (from $(Get-Short $Commit), $From)"
  return $dest
}

# -InstallChartBridge: pin staged\bin (checked when staged), unless the pinned copy is from a newer commit.
function Update-PinnedFromStage($Stage) {
  $pin = Read-JsonFile (Join-Path $script:P.Bin 'pinned.json')
  if (-not $pin) { return '' }                                  # no task registered: nothing to follow
  $sc = [string](Get-Field $Stage 'commit'); $pc = [string](Get-Field $pin 'commit')
  if ($pc -eq $sc) { return '' }
  $mb = Invoke-Git @('merge-base', '--is-ancestor', $pc, $sc) 30
  if ($pc -and $mb.code -ne 0) { return "The task's updater stays at $(Get-Short $pc): the staged commit is not newer." }
  [void](Install-PinnedUpdater (Join-Path (Join-Path $script:P.Staged 'bin') 'update-pc.ps1') $sc ([string](Get-Field $Stage 'updaterBlob')) '-InstallChartBridge')
  return "The task's updater now comes from $(Get-Short $sc)."
}

# register: which file to pin. The staged copy of the newest green main (fetched and staged now if need be), or the
# running file only when it is byte for byte the updater of a commit this PC has seen green.
function Get-PinSource($State) {
  $r = Invoke-Pass -StageOnly -State $State
  $stage = Read-JsonFile (Join-Path $script:P.Staged 'stage.json')
  if ($stage -and (Test-StagedIntact $stage)) {
    return @{ file = (Join-Path (Join-Path $script:P.Staged 'bin') 'update-pc.ps1'); commit = [string](Get-Field $stage 'commit'); blob = [string](Get-Field $stage 'updaterBlob'); note = "the staged copy of $(Get-Short (Get-Field $stage 'commit')) (green on main)" }
  }
  $mine = Get-BlobId $script:UpdaterSelf $script:SelfPath
  $pin = Read-JsonFile (Join-Path $script:P.Bin 'pinned.json')
  if ($mine -and $mine -eq [string](Get-Field $pin 'blob' '') -and (Get-Field $pin 'commit')) {
    return @{ file = $script:UpdaterSelf; commit = [string](Get-Field $pin 'commit'); blob = $mine; note = "this file, the same as the pinned $(Get-Short (Get-Field $pin 'commit'))" }
  }
  foreach ($c in @($State['ciGreen'])) {
    if (-not $c) { continue }
    $b = (Get-CommitBlobs $c @($script:SelfPath))[$script:SelfPath]
    if ($b -and $b -eq $mine) {
      # never back to an older updater than the one pinned (the same rule as -InstallChartBridge)
      $pc = [string](Get-Field $pin 'commit' '')
      if ($pc -and $pc -ne $c) {
        $mb = Invoke-Git @('merge-base', '--is-ancestor', $pc, $c) 30
        if ($mb.code -ne 0) { throw "nothing pinned: main could not be staged ($($r.outcome): $($r.reason)), and this update-pc.ps1 is the file of $(Get-Short $c), which is not newer than the pinned $(Get-Short $pc). The task keeps $(Get-Short $pc); run register again when main can be fetched" }
      }
      return @{ file = $script:UpdaterSelf; commit = $c; blob = $b; note = "this file, the same as in $(Get-Short $c) (green on main)" }
    }
  }
  throw "nothing to pin: main could not be staged ($($r.outcome): $($r.reason)), and this update-pc.ps1 is not the file of a commit seen green on main (a branch or a local edit?)"
}

# Is the scheduled task's copy (updater\bin\update-pc.ps1) still the file that was pinned? $null when it is, or when no
# copy is pinned on this PC. update.json and status.json carry the answer, so a task that stops is seen on the page.
function Get-PinnedProblem {
  $bin = Join-Path $script:P.Bin 'update-pc.ps1'
  $pj = Join-Path $script:P.Bin 'pinned.json'
  if (-not (Test-Path -LiteralPath $bin)) { return $null }
  if (-not (Test-Path -LiteralPath $pj)) { return "the task's updater $bin has no pinned.json next to it" }
  $want = [string](Get-Field (Read-JsonFile $pj) 'sha256' '')
  if (-not $want) { return "$pj cannot be read" }
  if ((Get-FileSha256 $bin) -ne $want) { return "the task's updater $bin changed since it was pinned" }
  return $null
}

# The pinned copy checks itself at every run: a changed file, or one without its pinned.json, does nothing and says
# STOP (update.log, status.json and the page).
function Test-PinnedSelf {
  $self = [IO.Path]::GetFullPath($script:UpdaterSelf)
  $dir = Split-Path -Parent $self
  $isPinned = ($self -eq [IO.Path]::GetFullPath((Join-Path $script:P.Bin 'update-pc.ps1'))) -or
    ((Split-Path -Leaf $dir) -eq 'bin' -and (Split-Path -Leaf (Split-Path -Parent $dir)) -eq 'updater')
  if (-not $isPinned) { return $null }
  $fix = 'nothing done. Run update-pc.ps1 register from the clone to pin a checked copy again'
  $pinFile = Join-Path $dir 'pinned.json'
  if (-not (Test-Path -LiteralPath $pinFile)) { return "the task's updater $self has no pinned.json next to it; $fix" }
  $pin = Read-JsonFile $pinFile
  if ((Get-FileSha256 $self) -ne (Get-Field $pin 'sha256')) { return "the task's updater $self changed since it was pinned; $fix" }
  return $null
}

# The self-check said STOP: status.json and update.json say so too (the page shows "Updater stopped").
function Write-StopRecord([string]$Text) {
  try {
    if (-not (Test-Path $script:P.Dir)) { return }
    $lock = Enter-Lock
    if (-not $lock) { return }
    try {
      $st = Read-JsonFile $script:P.Status
      if (-not ($st -is [System.Collections.IDictionary])) { $st = @{} }
      $st['schema'] = 1; $st['updatedAt'] = Get-NowMs; $st['outcome'] = 'updater_stopped'; $st['reason'] = $Text
      $st['updater'] = [ordered]@{ stopped = $true; reason = $Text }
      Write-JsonAtomic $script:P.Status $st
      $cur = Read-JsonFile (Join-Path $script:P.Www $script:VersionFile)
      $pg = Get-Field $cur 'page' @{}
      $script:UpdaterStopped = $true
      Write-UpdateDoc $pg ([string](Get-Field $pg 'state' '')) $null
    } finally { $lock.Dispose() }
  } catch { Write-Log "the STOP could not be written to status.json or update.json ($($_.Exception.Message))" 'WARN' }
}

# The daily trigger. New-ScheduledTaskTrigger -At writes StartBoundary with this PC's UTC offset of that day (for
# example 2026-09-30T17:05:00-04:00), and Task Scheduler then keeps the trigger on UTC ("Synchronize across time
# zones"): registered in summer, it would run an hour early (New York time) all winter. So StartBoundary
# is written as local wall-clock time with no offset (2026-09-30T17:05:00): Task Scheduler then runs it at 17:05 on
# this PC's clock every day, across DST.
function New-DailyTrigger([datetime]$Local) {
  $t = New-ScheduledTaskTrigger -Daily -At $Local
  $t.StartBoundary = $Local.ToString('yyyy-MM-ddTHH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
  return $t
}

# The wall-clock HH:mm of a StartBoundary string, and whether it carries a UTC offset (Z or +hh:mm): read from the
# string itself, never converted through the offset it holds (that would hide a trigger kept on UTC).
function Read-StartBoundary([string]$Text) {
  $m = [regex]::Match("$Text".Trim(), '^\d{4}-\d\d-\d\dT(\d\d):(\d\d)(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)?$')
  if (-not $m.Success) { return @{ ok = $false; hhmm = ''; offset = $false } }
  return @{ ok = $true; hhmm = "$($m.Groups[1].Value):$($m.Groups[2].Value)"; offset = [bool]$m.Groups[5].Success }
}

# The daily checks are local times on this PC. At every update run, pinned.json's daily times (New York time,
# Get-PinTimes) are worked out again for today, and the daily triggers are moved when they drifted (a time zone change,
# DST dates that differ from New York's, or a StartBoundary kept on UTC), only in the task's own run (Get-OwnRunProblem;
# a run of the clone's copy changes no trigger and says so). A daily trigger missing (a task registered with one, before 09:00 and
# 17:00) is added, also only on the task's own launcher (Get-AddTriggerProblem): a change of the schedule, never of the
# action. More daily triggers than times, or none, are left to register. Returns what it found, for
# state.json and status: a failure (a task registered from an elevated window cannot be changed by the task's own run:
# access denied) is recorded, not only logged.
function Sync-DailyTrigger {
  if ($env:OS -ne 'Windows_NT') { return $null }
  $res = @{ at = (Get-NowMs); ok = $true; have = ''; want = ''; error = ''; note = '' }
  try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { return $null }
    $times = @(Get-PinTimes (Read-JsonFile (Join-Path $script:P.Bin 'pinned.json')))
    $plan = Get-DailyPlan $task $times
    $res.have = $plan.have; $res.want = $plan.want
    if ($plan.action -eq 'none') { return $res }
    $ny = "$(Format-DailyTimes $times) New York time"
    if ($plan.action -eq 'leave') {
      $res.note = $plan.why
      Write-Log "the daily checks were left alone: $($plan.why)" 'WARN'
      return $res
    }
    if ($plan.action -eq 'add') {
      $why = Get-AddTriggerProblem $task
      if ($why) {
        $res.note = "the daily check at $(Format-DailyTimes $plan.missing) New York time was not added: $why"
        Write-Log "$($res.note)" 'WARN'
        return $res
      }
    } else {
      $why = Get-OwnRunProblem $task
      if ($why) {
        $res.note = "the daily checks were not moved (they are $($plan.have) on this PC's clock, wanted $($plan.want)): $why"
        Write-Log "$($res.note)" 'WARN'
        return $res
      }
    }
    Set-ScheduledTask -TaskName $TaskName -Trigger (@($plan.others) + @($plan.local | ForEach-Object { New-DailyTrigger $_ })) | Out-Null
    if ($plan.action -eq 'add') {
      Write-Log "the daily check at $(Format-DailyTimes $plan.missing) New York time was added to the task (it had $($plan.have) on this PC's clock; now $($plan.want), $ny)"
    } else {
      $why = ''; if ($plan.utc) { $why = ' (it was kept on UTC: StartBoundary had a UTC offset)' }
      Write-Log "the daily check moved from $($plan.have) to $($plan.want) on this PC's clock ($ny)$why" 'WARN'
    }
    $res.have = $res.want
  } catch {
    $res.ok = $false; $res.error = $_.Exception.Message
    Write-Log "the daily check time could not be checked or moved ($($res.error)); if the task was registered from an elevated window, run update-pc.ps1 register again from a normal (not elevated) PowerShell window" 'WARN'
  }
  return $res
}

# The daily times, New York time: -DailyAt or pinned.json's, given as 09:00,17:00 (one command line argument) or as a
# list, each HH:mm; sorted, each once. Anything else throws.
function Get-DailyTimes($At) {
  $t = @(@($At) | ForEach-Object { "$_".Split(',') } | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Sort-Object -Unique)
  if ($t.Count -eq 0) { throw 'no daily time is given' }
  foreach ($x in $t) { if ($x -notmatch '^([01][0-9]|2[0-3]):[0-5][0-9]$') { throw "the daily time '$x' is not HH:mm" } }
  return $t
}

# 09:00 and 17:00
function Format-DailyTimes($Times) { return (@($Times) -join ' and ') }

# The pin's daily times (New York time). pinned.json carries dailyTimes (this version) and dailyAt (their first, which a
# pinned copy older than this change reads alone). A pin without dailyTimes, or whose dailyTimes do not start with its
# dailyAt (an older copy wrote dailyAt since), was written before the two daily checks: no time or an old default (17:05,
# 09:00) reads as the default 09:00 and 17:00 (Anthony 2026-10-23); another time is kept, alone.
function Get-PinTimes($Pin) {
  $at = [string](Get-Field $Pin 'dailyAt' '')
  $list = Get-Field $Pin 'dailyTimes'
  if ($null -ne $list) {
    try { $t = @(Get-DailyTimes $list); if ($t[0] -eq $at) { return $t } } catch { }
  }
  if (-not $at -or $script:DailyAtBefore -contains $at) { return @(Get-DailyTimes $script:DailyAtDefault) }
  return @(Get-DailyTimes $at)
}

# Writes the daily times into a pin: dailyTimes, and dailyAt (the first) for an older pinned copy.
function Set-PinTimes($Pin, $Times) {
  $t = @(Get-DailyTimes $Times)
  $Pin['dailyAt'] = $t[0]
  $Pin['dailyTimes'] = $t
}

# The daily times as this PC's local times on a day (New York time worked out for that day).
function Get-DailyLocal($Times, [datetime]$Day = (Get-Date)) {
  return @(@($Times) | ForEach-Object { ConvertFrom-NewYorkTime $_ $Day })
}

# The task's triggers, and a trigger's kind (MSFT_TaskDailyTrigger, MSFT_TaskLogonTrigger)
function Get-TaskTriggers($Task) {
  if ($null -eq $Task) { return @() }
  $p = $Task.PSObject.Properties['Triggers']
  if (-not $p -or $null -eq $p.Value) { return @() }
  return @($p.Value)
}
function Get-TriggerClass($Trigger) {
  try { return [string]$Trigger.CimClass.CimClassName } catch { return '' }
}

# What the daily triggers need, for these daily times today: @{ action = none | move | add | leave; why; others (the
# triggers that are not daily); local (the wanted local times); want and have (HH:mm on this PC's clock, joined by ,);
# missing (the New York times with no trigger); utc (a trigger kept on UTC) }. The same in Bot-Lab's botlab_update.ps1.
function Get-DailyPlan($Task, $Times) {
  $times = @(Get-DailyTimes $Times)
  $local = @(Get-DailyLocal $times)
  $all = @(Get-TaskTriggers $Task)
  $daily = @($all | Where-Object { (Get-TriggerClass $_) -eq 'MSFT_TaskDailyTrigger' })
  $others = @($all | Where-Object { (Get-TriggerClass $_) -ne 'MSFT_TaskDailyTrigger' })
  $inv = [Globalization.CultureInfo]::InvariantCulture
  $wantHm = @($local | ForEach-Object { $_.ToString('HH:mm', $inv) })
  $read = @($daily | ForEach-Object { Read-StartBoundary ([string]$_.StartBoundary) })
  $clean = @($read | Where-Object { $_.ok -and -not $_.offset } | ForEach-Object { $_.hhmm })
  $p = @{ action = 'none'; why = ''; others = $others; local = $local; missing = @(); utc = $false
    want = (@($wantHm | Sort-Object) -join ','); have = (@($read | ForEach-Object { $_.hhmm } | Sort-Object) -join ',') }
  $p.utc = (@($read | Where-Object { $_.offset }).Count -gt 0)
  for ($i = 0; $i -lt $times.Count; $i++) { if ($clean -notcontains $wantHm[$i]) { $p.missing += $times[$i] } }
  if ($daily.Count -eq 0) { $p.action = 'leave'; $p.why = 'the task has no daily trigger; register sets them'; return $p }
  if ($daily.Count -gt $times.Count) {
    $p.action = 'leave'
    $p.why = "the task has $($daily.Count) daily triggers ($($p.have) on this PC's clock), more than the daily times ($(Format-DailyTimes $times) New York time); register sets them"
    return $p
  }
  if ($daily.Count -lt $times.Count) { $p.action = 'add'; return $p }
  if ($p.missing.Count -or $clean.Count -ne $daily.Count) { $p.action = 'move' }
  return $p
}

# The next run of a daily trigger at HH:mm on this PC's clock, after Now
function Get-NextDailyRun([string]$HHmm, [datetime]$Now) {
  $h, $m = $HHmm.Split(':')
  $next = $Now.Date.AddHours([int]$h).AddMinutes([int]$m)
  if ($next -le $Now) { $next = $next.AddDays(1) }
  return $next.ToString('yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture)
}

# status: one line per daily time (New York time, its time on this PC's clock, its next run) and one per daily trigger
# that is none of them. The same in Bot-Lab's botlab_update.ps1.
function Get-DailyLines($Task, $Times, [datetime]$Now = (Get-Date)) {
  $out = @()
  $inv = [Globalization.CultureInfo]::InvariantCulture
  $daily = @(Get-TaskTriggers $Task | Where-Object { (Get-TriggerClass $_) -eq 'MSFT_TaskDailyTrigger' })
  $used = @{}
  foreach ($t in @(Get-DailyTimes $Times)) {
    $hm = (ConvertFrom-NewYorkTime $t $Now).ToString('HH:mm', $inv)
    $hit = -1
    for ($i = 0; $i -lt $daily.Count; $i++) {
      $sb = Read-StartBoundary ([string]$daily[$i].StartBoundary)
      if (-not $used.ContainsKey($i) -and $sb.ok -and -not $sb.offset -and $sb.hhmm -eq $hm) { $hit = $i; break }
    }
    if ($hit -ge 0) { $used[$hit] = $true; $out += "$t New York time, $hm on this PC's clock, next run $(Get-NextDailyRun $hm $Now)" }
    else { $out += "$t New York time, $hm on this PC's clock: NO TRIGGER at that time yet (the next run sets it; update.log says when it cannot)" }
  }
  for ($i = 0; $i -lt $daily.Count; $i++) {
    if ($used.ContainsKey($i)) { continue }
    $sb = Read-StartBoundary ([string]$daily[$i].StartBoundary)
    $what = 'DRIFTED'; if ($sb.offset) { $what = 'KEPT ON UTC (StartBoundary has an offset)' }
    $out += "a daily trigger at $($sb.hhmm) on this PC's clock (StartBoundary $($daily[$i].StartBoundary)) is none of them: $what, the next run moves it"
  }
  return $out
}

# Every change of the daily triggers in the automatic run (Anthony 2026-10-23: a move too, not only an add) is made only
# in the task's own run, as Bot-Lab's botlab_update.ps1: the task runs the pinned copy, and this run is that copy; this
# run is not elevated, and the task runs as this user, only while signed in (logon type Interactive, review C3 of #68). A
# run of the clone's copy changes no trigger and says so; the pinned copy run by hand ($u in the README) counts as the
# task's own run when it is not elevated and runs as the task's user. '' when it may.
function Get-OwnRunProblem($Task) {
  $pinned = Join-Path $script:P.Bin 'update-pc.ps1'
  $cmd = Get-TaskCommand $Task
  if ($cmd.error) { return "the task's command cannot be read ($($cmd.error)); run update-pc.ps1 register" }
  $o = Get-CommandOptions $cmd.line 'update-pc.ps1' $script:OwnParams
  if ($null -eq $o -or -not (Test-SamePath ([string]$o['#script']) $pinned)) { return "the task does not run the pinned copy $pinned; run update-pc.ps1 register" }
  if ($o.ContainsKey('#error')) { return "the task's $($o['#error'])" }
  if (-not (Test-SamePath $script:UpdaterSelf $pinned)) { return "this run is $($script:UpdaterSelf), not the task's pinned copy $pinned (the clone's copy: the task's own run, or the pinned copy run by hand, does it)" }
  if (Test-Elevated) { return 'this run is elevated (Run as administrator); run update-pc.ps1 register from a normal window' }
  $u = Get-TaskUserId $Task
  $me = Get-CurrentUserName
  if (-not $u) { return "the task's user cannot be read; run update-pc.ps1 register" }
  if (-not (Test-SameUser $u $me)) { return "the task runs as $u, this run as ${me}; run update-pc.ps1 register as $u" }
  $lt = Get-TaskLogonType $Task
  if ($lt -ne 'Interactive') { return "$(Get-LogonTypeText $lt); run update-pc.ps1 register" }
  return ''
}

# Adding a daily trigger in the automatic run (Anthony 2026-10-23: no job per PC): a change of the schedule only, never of
# the action, in the task's own run (Get-OwnRunProblem), and only when the task starts through its own hidden launcher.
# A task not on its own launcher yet gets both daily triggers when it moves to it (-InstallChartBridge or register).
function Get-AddTriggerProblem($Task) {
  if (-not (Get-TaskLauncherPath $Task)) { return 'the task does not start through its own hidden launcher yet: -InstallChartBridge or update-pc.ps1 register moves it with both daily checks' }
  return (Get-OwnRunProblem $Task)
}

# What the last check of the daily trigger found, in state.json: failedAt stays until a check succeeds again.
function Save-TriggerCheck($State, $Res) {
  if ($null -eq $Res) { return }
  $prev = Get-Field $State 'dailyTrigger' @{}
  $d = @{ checkedAt = $Res.at; ok = $Res.ok; have = $Res.have; want = $Res.want; note = (Get-Field $Res 'note' '') }
  if (-not $Res.ok) { $d['failedAt'] = $Res.at; $d['error'] = $Res.error; $d['failingSince'] = (Get-Field $prev 'failingSince' $Res.at) }
  $State['dailyTrigger'] = $d
}

# HH:mm New York time on a given day, as this PC's local time (DST on both sides, on that day).
function ConvertFrom-NewYorkTime([string]$HHmm, [datetime]$Day = (Get-Date)) {
  $tz = $null
  foreach ($id in @('Eastern Standard Time', 'America/New_York')) {
    try { $tz = [TimeZoneInfo]::FindSystemTimeZoneById($id); break } catch { }
  }
  if (-not $tz) { throw 'the New York time zone is not known on this PC' }
  $h, $m = $HHmm.Split(':')
  $ny = New-Object DateTime($Day.Year, $Day.Month, $Day.Day, [int]$h, [int]$m, 0, [DateTimeKind]::Unspecified)
  return [TimeZoneInfo]::ConvertTime($ny, $tz, [TimeZoneInfo]::Local)
}

# register's pin (any system): pick a checked copy, pin it, remember the daily times. Returns the pinned path. $Register
# (register's task) runs once the copy is picked and before anything is pinned (1.39.1, the hidden-register review: the
# pinned copy and pinned.json are written only after a successful register; a register that fails leaves them as they were).
function Invoke-PinForTask($At, [scriptblock]$Register = $null) {
  $lock = Enter-Lock
  if (-not $lock) { throw (Get-BusyText) }
  try {
    $state = Read-State
    $src = Get-PinSource $state
    Save-State $state
    if ($Register) { $null = & $Register }
    $pinned = Install-PinnedUpdater $src.file $src.commit $src.blob 'register'
    $pj = Join-Path $script:P.Bin 'pinned.json'
    $pin = Read-JsonFile $pj; Set-PinTimes $pin $At; Write-JsonAtomic $pj $pin
    Write-Host "pinning:      $($src.note)"
    return $pinned
  } finally { $lock.Dispose() }
}

# ------------------------------------------------------------------------------------------------ hidden start
# The same functions, Get-SystemExe to Test-TaskStart, in chart-engine's nt8/update-pc.ps1 and Bot-Lab's
# tools/botlab_update.ps1 and tools/manrae_night.ps1 (see "Hidden start" at the top).

# A program under %SystemRoot% (C:\Windows when it is not set: tests off Windows), written as Join-Path would on Windows.
function Get-SystemExe([string]$Rel) {
  $root = "$env:SystemRoot"
  if (-not $root) { $root = 'C:\Windows' }
  return ($root.TrimEnd('\') + '\' + $Rel)
}

# The launcher's one line: WScript.Shell.Run of exactly the program and arguments the task would start, window style 0
# (hidden), True (wait: its exit code is the task's Last Result). VBScript doubles a quote inside a string. Refused: a
# character outside printable ASCII (the file is ASCII; a path with such a character would be changed) and % (Run would
# expand %NAME% as an environment variable).
function Get-HiddenLauncherLine([string]$Execute, [string]$Arguments) {
  $cmd = '"' + $Execute + '" ' + $Arguments
  if ($cmd -match '[^\x20-\x7E]') { throw "the command line has a character an ASCII launcher cannot hold: $cmd" }
  if ($cmd.Contains('%')) { throw "the command line has a % (WScript.Shell.Run would read it as an environment variable): $cmd" }
  return ('WScript.Quit CreateObject("WScript.Shell").Run("' + $cmd.Replace('"', '""') + '", 0, True)')
}

# Writes the launcher (ASCII, the one line and a line end) and reads it back; any failure throws, so register stops
# before it touches the task.
function Write-HiddenLauncher([string]$Path, [string]$Line) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $text = $Line + "`r`n"
  [IO.File]::WriteAllText($Path, $text, [Text.Encoding]::ASCII)
  if ([IO.File]::ReadAllText($Path, [Text.Encoding]::ASCII) -cne $text) { throw "the launcher $Path did not read back as written" }
}

# The launcher a task's action starts (wscript.exe //B "<path>", or without //B), when it is one of ours (its file name); '' otherwise.
function Get-TaskLauncherPath($Task) {
  if (-not $Task) { return '' }
  foreach ($a in @($Task.Actions)) {
    if (-not $a -or "$($a.Execute)" -notmatch '(?i)(^|[\\/])wscript\.exe"?$') { continue }
    $m = [regex]::Match("$($a.Arguments)", '(?i)^\s*(//B\s+)?"([^"]+)"')
    if ($m.Success -and $m.Groups[2].Value -match ('(^|[\\/])' + [regex]::Escape($script:HiddenLauncherName) + '$')) { return $m.Groups[2].Value }
  }
  return ''
}

# unregister: the launcher this script writes, and the one the task named (when it has our file name), are removed.
function Remove-HiddenLauncher([string[]]$Paths) {
  $done = @()
  foreach ($p in @($Paths | Where-Object { $_ } | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $p -PathType Leaf) { Remove-Item -LiteralPath $p -Force; $done += $p }
  }
  return $done
}

# A command line's arguments, by the Windows rules (CommandLineToArgvW; Format-Arg writes them so): spaces split outside
# quotes, 2n backslashes before a quote are n and the quote opens or closes, 2n+1 are n and a literal quote.
function Split-CommandLine([string]$Line) {
  $out = New-Object System.Collections.ArrayList
  $cur = New-Object System.Text.StringBuilder
  $inQ = $false; $any = $false; $i = 0
  while ($i -lt $Line.Length) {
    $ch = [string]$Line[$i]
    if ($ch -eq '\') {
      $n = 0
      while ($i -lt $Line.Length -and [string]$Line[$i] -eq '\') { $n++; $i++ }
      if ($i -lt $Line.Length -and [string]$Line[$i] -eq '"') {
        [void]$cur.Append('\' * [int][Math]::Floor($n / 2))
        if ($n % 2 -eq 1) { [void]$cur.Append('"'); $i++ }
      } else { [void]$cur.Append('\' * $n) }
      $any = $true; continue
    }
    if ($ch -eq '"') { $inQ = -not $inQ; $any = $true; $i++; continue }
    if (-not $inQ -and ($ch -eq ' ' -or $ch -eq "`t")) {
      if ($any) { [void]$out.Add($cur.ToString()); [void]$cur.Clear(); $any = $false }
      $i++; continue
    }
    [void]$cur.Append($ch); $any = $true; $i++
  }
  if ($any) { [void]$out.Add($cur.ToString()) }
  return $out.ToArray()
}

# The command line a launcher's Run("...") holds, quotes undoubled: ours, or a hand-made one (C:\SchwabDesk_bulk\hidden,
# the same form, maybe with "cmd /c cd /d <folder> && " in front, which is taken off; also cmd /s /c "cd /d "<folder>" &&
# <command>", as WORK and HOME wrote theirs on 2026-10-22: /s takes off the quotes around the whole). '' when it holds no
# Run line.
function Get-LauncherCommand([string]$Path) {
  $m = [regex]::Match([IO.File]::ReadAllText($Path), '(?i)\.Run\(\s*"((?:[^"]|"")*)"')
  if (-not $m.Success) { return '' }
  $cmd = $m.Groups[1].Value.Replace('""', '"').Trim()
  $c = [regex]::Match($cmd, '(?i)^"?([^"]*[\\/])?cmd(\.exe)?"?\s+(/s\s+)?/c\s+(.*)$')
  if ($c.Success) {
    $rest = $c.Groups[4].Value.Trim()
    if ($rest.Length -ge 2 -and $rest.StartsWith('"') -and $rest.EndsWith('"')) { $rest = $rest.Substring(1, $rest.Length - 2).Trim() }
    $d = [regex]::Match($rest, '(?i)^cd\s+/d\s+.*?&&\s*(.*)$')
    if ($d.Success) { $cmd = $d.Groups[1].Value.Trim() }
  }
  return $cmd
}

# What the current task runs: @{ found; launcher (the .vbs it starts, or ''); source (said in messages); line (the whole
# command line); error }. Its action is the program itself with its arguments, or wscript.exe on a launcher (ours or a
# hand-made one) whose Run line holds the command.
function Get-TaskCommand($Task) {
  $r = @{ found = $false; launcher = ''; source = ''; line = ''; error = '' }
  if (-not $Task) { return $r }
  $r.found = $true
  $a = @($Task.Actions) | Select-Object -First 1
  if (-not $a) { $r.error = 'the task has no action'; return $r }
  $exe = "$($a.Execute)".Trim().Trim('"')
  if ($exe -match '(?i)(^|[\\/])wscript\.exe$') {
    $t = @(Split-CommandLine "$($a.Arguments)" | Where-Object { $_ -notmatch '^//' })
    if ($t.Count -lt 1) { $r.error = 'its wscript.exe names no launcher'; return $r }
    $r.launcher = $t[0]; $r.source = "the launcher $($t[0])"
    if (-not (Test-Path -LiteralPath $t[0] -PathType Leaf)) { $r.error = "its launcher $($t[0]) is missing"; return $r }
    try { $r.line = Get-LauncherCommand $t[0] } catch { $r.error = "its launcher $($t[0]) cannot be read: $($_.Exception.Message)"; return $r }
    if (-not $r.line) { $r.error = "its launcher $($t[0]) holds no Run(""..."") line" }
    return $r
  }
  $r.source = "the task's action ($exe)"
  $r.line = (Format-Arg $exe) + ' ' + "$($a.Arguments)"
  return $r
}

# A command line's script (after -File; its file name must be $Leaf) and its options: @{ '#exe'; '#script'; '#command';
# <Name> = value } ($true for a switch); $null when it does not run that script. Names as PowerShell binds them (1.39.1,
# the hidden-register review): -Name value, -Name:value and -Name: value, in any case; with $Known (the script's own
# parameters), an unambiguous start of one (-Rep) is that one. '#error' (with a hint) when PowerShell itself would refuse
# the line before the script runs, so every run of the task fails: an option given twice, a name that is no parameter of
# the script, or one that starts two of them.
function Get-CommandOptions([string]$Line, [string]$Leaf, [string[]]$Known = @()) {
  $t = @(Split-CommandLine $Line)
  $f = -1
  for ($i = 1; $i -lt $t.Count; $i++) { if ($t[$i] -eq '-File') { $f = $i; break } }
  if ($f -lt 0 -or $f + 1 -ge $t.Count) { return $null }
  $script = $t[$f + 1]
  $named = ('(^|[\\/])' + [regex]::Escape($Leaf) + '$')
  if ($script -notmatch $named -and (Get-LongPath $script) -notmatch $named) { return $null }   # 1.39.1: or by its 8.3 short name
  $o = @{ '#exe' = $t[0]; '#script' = $script; '#command' = '' }
  $err = @()
  $j = $f + 2
  if ($j -lt $t.Count -and $t[$j] -notmatch '^-[A-Za-z]') { $o['#command'] = $t[$j]; $j++ }
  while ($j -lt $t.Count) {
    $m = [regex]::Match($t[$j], '^-([A-Za-z][A-Za-z0-9]*)(:(.*))?$')
    if (-not $m.Success) { $j++; continue }
    $name = $m.Groups[1].Value
    if ($Known.Count) {
      $hit = @($Known | Where-Object { $_ -eq $name })
      if (-not $hit.Count -and $script:OwnAliases.ContainsKey($name) -and $Known -contains $script:OwnAliases[$name]) { $hit = @($script:OwnAliases[$name]) }
      if (-not $hit.Count) { $hit = @($Known | Where-Object { $_.StartsWith($name, [StringComparison]::OrdinalIgnoreCase) }) }
      if ($hit.Count -eq 1) { $name = $hit[0] }
      elseif ($hit.Count -gt 1) { $err += "-$name could be any of -$($hit -join ', -')" }
      else { $err += "-$name is not an option of $Leaf" }
    }
    if ($m.Groups[2].Success) {                                # -Name:value, or -Name: value
      $v = $m.Groups[3].Value; $j++
      if ($v -eq '' -and $j -lt $t.Count) { $v = $t[$j]; $j++ }
      if ($v -eq '$true') { $v = $true } elseif ($v -eq '$false') { $v = $false }
    } elseif ($j + 1 -lt $t.Count -and $t[$j + 1] -notmatch '^-[A-Za-z]') { $v = $t[$j + 1]; $j += 2 }
    else { $v = $true; $j++ }
    if ($o.ContainsKey($name)) {
      $was = $(if ($o[$name] -is [bool]) { 'a switch' } else { [string]$o[$name] }); $now = $(if ($v -is [bool]) { 'a switch' } else { [string]$v })
      $err += "-$name is given twice ($was, then $now)"
      continue
    }
    $o[$name] = $v
  }
  if ($err.Count) {
    $o['#error'] = "its command line would not run: $($err -join '; '). PowerShell refuses such a line before the script starts, so every run of the task fails. Give each option once, as -Name value: update-pc.ps1 unregister, then register, writes it again"
  }
  return $o
}

# status: the task's start, checked. @{ ok; text; line }. Not ok (status then ends with exit code 1): the launcher the
# task starts is missing or cannot be read, or ours holds anything but exactly the line register writes for the command
# it holds ($Expected: the options read from it -> that line). A hand-made launcher or a visible start is said, not an
# error (the task still runs).
function Test-TaskStart($Task, [string]$Leaf, [scriptblock]$Expected, [string[]]$Known = @()) {
  $cmd = Get-TaskCommand $Task
  if ($cmd.error) { return @{ ok = $false; line = ''; text = "LAUNCHER MISSING OR UNREADABLE ($($cmd.error)): the task's runs fail, updates are not running; run register" } }
  $o = Get-CommandOptions $cmd.line $Leaf $Known
  if ($null -ne $o -and $o.ContainsKey('#error')) { return @{ ok = $false; line = $cmd.line; text = "TASK COMMAND REFUSED ($($cmd.source)): $($o['#error'])" } }
  $ours = Get-TaskLauncherPath $Task
  if (-not $cmd.launcher) { return @{ ok = $true; line = $cmd.line; text = "not hidden: $($cmd.source) starts it (a console may flash); run register" } }
  if (-not $ours) { return @{ ok = $true; line = $cmd.line; text = "hidden by a launcher register did not write ($($cmd.launcher)); run register to move it to its own" } }
  if ($null -eq $o) { return @{ ok = $false; line = $cmd.line; text = "LAUNCHER CHANGED: $ours does not run $Leaf; updates are not running as registered; run register" } }
  try { $want = (& $Expected $o) + "`r`n" } catch { return @{ ok = $false; line = $cmd.line; text = "LAUNCHER CHANGED: the command in $ours cannot be rebuilt ($($_.Exception.Message)); run register" } }
  if ([IO.File]::ReadAllText($ours) -cne $want) { return @{ ok = $false; line = $cmd.line; text = "LAUNCHER CHANGED: $ours is not the line register writes for its command; updates may not run as registered; run register" } }
  return @{ ok = $true; line = $cmd.line; text = "hidden (wscript.exe //B $ours)" }
}

# ------------------------------------------------------------------------------------------------ register

function Get-HiddenLauncherPath { return (Join-Path $script:P.Bin $script:HiddenLauncherName) }

# A path with each 8.3 short part (RUNNER~1, UPDATE~1.PS1) put in its long form, as Windows names it; a path with no ~ is
# returned as given (HOME's and WORK's long paths are never touched), and a part that does not exist is kept as written.
# GetFullPath does not do this (.NET 4.6.2 and later, and pwsh, leave short names as they are), nor Get-Item's FullName:
# each part is looked up in its parent (GetFileSystemEntries, whose search pattern matches a short name and returns the
# long one). 1.39.1, CI of #72: the task's -File named by its short name was not the pinned copy.
function Get-LongPath([string]$Path) {
  if (-not $Path -or -not $Path.Contains('~')) { return $Path }
  try {
    $full = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetPathRoot($full)
    $cur = $root
    foreach ($part in @($full.Substring($root.Length).Split([char[]]@('\', '/')) | Where-Object { $_ })) {
      $next = Join-Path $cur $part
      if ($part.Contains('~') -and [IO.Directory]::Exists($cur)) {
        $hit = @([IO.Directory]::GetFileSystemEntries($cur, $part))
        if ($hit.Count -eq 1) { $next = $hit[0] }
      }
      $cur = $next
    }
    return $cur
  } catch { return $Path }
}

# The same path: as GetFullPath writes them (each 8.3 short part in its long form first, Get-LongPath), or, when both
# exist, as Windows names them
function Test-SamePath([string]$A, [string]$B) {
  $A = Get-LongPath $A; $B = Get-LongPath $B
  if ([IO.Path]::GetFullPath($A).TrimEnd('\', '/') -eq [IO.Path]::GetFullPath($B).TrimEnd('\', '/')) { return $true }
  try {
    if ((Test-Path -LiteralPath $A) -and (Test-Path -LiteralPath $B)) {
      return ((Get-Item -LiteralPath $A -Force).FullName.TrimEnd('\', '/') -eq (Get-Item -LiteralPath $B -Force).FullName.TrimEnd('\', '/'))
    }
  } catch { }
  return $false
}

# register keeps what the current task runs (B1 of the review, 2026-10-23): its -Repo, read from the task's own
# arguments or from the line of the launcher it starts (ours or a hand-made one in C:\SchwabDesk_bulk\hidden). Another
# clone than this one is refused unless -Repo is given (-Repo '' cannot clear it); so is a task whose command cannot be
# read. Returns @{ error; notes }.
function Resolve-TaskOptions($Task, [hashtable]$Bound = $script:Bound) {
  $res = @{ error = ''; notes = @() }
  if (-not $Task) { return $res }
  $how = 'nothing changed; run update-pc.ps1 unregister first to register from scratch'
  $cmd = Get-TaskCommand $Task
  if ($cmd.error) { $res.error = "the current task's command cannot be read ($($cmd.error)): $how"; return $res }
  $o = Get-CommandOptions $cmd.line 'update-pc.ps1' $script:OwnParams
  if ($null -eq $o) { $res.error = "the current task ($($cmd.source)) does not run update-pc.ps1: $how"; return $res }
  if ($o.ContainsKey('#error')) { $res.error = "the current task ($($cmd.source)): $($o['#error'])"; return $res }
  $old = [string]$o['Repo']
  if ($old -and $Bound.ContainsKey('Repo') -and -not [string]$Bound['Repo']) { $res.error = "-Repo '' would drop the task's -Repo ${old}: give the clone (-Repo $old keeps it)"; return $res }
  if ($old -and -not (Test-SamePath $old $script:P.Repo)) {
    if (-not $Bound.ContainsKey('Repo')) { $res.error = "the current task runs the clone $old ($($cmd.source)), not $($script:P.Repo): give -Repo to change it (-Repo $old keeps it); nothing changed"; return $res }
    $res.notes += "-Repo $($script:P.Repo) (given; the task had $old)"
  }
  return $res
}

# The launcher for the task's command (the pinned copy, -Repo this clone), written and read back; a failure throws.
function Write-TaskLauncher([string]$Pinned) {
  $ps = Get-SystemExe 'System32\WindowsPowerShell\v1.0\powershell.exe'
  try { Write-HiddenLauncher (Get-HiddenLauncherPath) (Get-HiddenLauncherLine $ps (Get-TaskArguments $Pinned $script:P.Repo)) }
  catch { throw "the hidden launcher could not be written, the task was not changed: $($_.Exception.Message)" }
}

# The launcher as it was before a change, to put back byte for byte when the change fails (1.39.1, the $hadLauncher of #66's
# review: the old launcher was read as text and written back as ASCII, and a read that failed left $hadLauncher set with no
# text, so the put-back would have written an empty launcher over a good one). Reading it throws before anything is written.
function Save-LauncherBackup([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @{ path = $Path; had = $false; bytes = $null } }
  return @{ path = $Path; had = $true; bytes = (Read-LauncherBytes $Path) }
}
function Read-LauncherBytes([string]$Path) { return , ([IO.File]::ReadAllBytes($Path)) }   # one place (a test holds the file)
function Restore-LauncherBackup($Backup) {
  if (-not $Backup) { return }
  if ($Backup.had) { [IO.File]::WriteAllBytes($Backup.path, [byte[]]$Backup.bytes) }
  elseif (Test-Path -LiteralPath $Backup.path -PathType Leaf) { Remove-Item -LiteralPath $Backup.path -Force }
}

# register's task: the launcher (again, the same line), then the task (this user, only while signed in, not elevated):
# at sign-in, and one daily trigger per local time. The tests run it with the ScheduledTasks commands stubbed.
function Register-HiddenTask([string]$User, [string]$Pinned, [datetime[]]$Local) {
  Write-TaskLauncher $Pinned
  $launcher = Get-HiddenLauncherPath
  $action = New-ScheduledTaskAction -Execute (Get-SystemExe 'System32\wscript.exe') -Argument ('//B "' + $launcher + '"') -WorkingDirectory $script:P.Bin
  $logon = New-ScheduledTaskTrigger -AtLogOn -User $User
  $logon.Delay = 'PT2M'
  $daily = @($Local | ForEach-Object { New-DailyTrigger $_ })
  $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger (@($logon) + $daily) -Principal $principal -Settings $settings -Force `
    -Description "Keeps the chart page in ChartBridge's www folder up to date (green commits on main only). Never installs ChartBridge. Log: $($script:P.Log)" | Out-Null
}

# The user the task runs as (this Windows user, as register), and whether this window is elevated
function Get-CurrentUserName { return [Security.Principal.WindowsIdentity]::GetCurrent().Name }
function Test-Elevated { return (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }

# -InstallChartBridge moves the scheduled task to the hidden launcher, once (Anthony 2026-10-23: no register job per PC).
# The automatic path never changes the pinned copy the task runs, so -InstallChartBridge (or register) is where a new
# updater first runs. Only the task named -TaskName, when it is not started by this tool's own launcher (plain
# powershell.exe, or a hand-made launcher in C:\SchwabDesk_bulk\hidden). Exactly register's path: the task's -Repo kept
# (Resolve-TaskOptions: another clone, or a command that cannot be read, is refused by name), the launcher written and
# read back, then the task. The daily times: as Get-PinTimes reads pinned.json (a pin written before the two daily checks
# with 17:05, 09:00 or none moves to 09:00 and 17:00; another time is kept). Task Scheduler applies a changed action from the task's next start. A failure is said and logged and
# never stops -InstallChartBridge. Returns the lines to print. -By: who moves it (-InstallChartBridge, register's moves
# are its own; "the task's own run" for a hand-made launcher, Invoke-AutoTaskMigration). Refused by name too: an option
# the launcher's line does not carry (it carries update -Repo alone), a command other than update.
function Invoke-TaskMigration([string]$By = '-InstallChartBridge') {
  if ($env:OS -ne 'Windows_NT') { return @() }
  $line = ''
  $launcher = ''; $backup = $null; $registered = $false
  try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task -or (Get-TaskLauncherPath $task)) { return @() }
    $pinned = Join-Path $script:P.Bin 'update-pc.ps1'
    $pj = Join-Path $script:P.Bin 'pinned.json'
    $pin = Read-JsonFile $pj
    $taskUser = Get-TaskUserId $task
    $me = Get-CurrentUserName
    $keep = $null; $o = $null
    if (-not $pin -or -not (Test-Path -LiteralPath $pinned)) { $line = "no pinned copy in $($script:P.Bin) (run update-pc.ps1 register)" }
    elseif (Test-Elevated) { $line = 'this window is elevated (Run as administrator): a task registered from it could not move its own daily check. Run -InstallChartBridge or update-pc.ps1 register from a normal window' }
    elseif (-not $taskUser) { $line = 'the task''s user cannot be read' }
    elseif (-not (Test-SameUser $taskUser $me)) { $line = "the task runs as $taskUser, this window is ${me}: run update-pc.ps1 register as $taskUser" }
    elseif ((Get-TaskLogonType $task) -ne 'Interactive') { $line = "$(Get-LogonTypeText (Get-TaskLogonType $task)): run update-pc.ps1 register" }
    else {
      $keep = Resolve-TaskOptions $task @{}
      if ($keep.error) { $line = $keep.error }
      else {
        $o = Get-CommandOptions (Get-TaskCommand $task).line 'update-pc.ps1' $script:OwnParams
        $extra = @(@($o.Keys) | Where-Object { [string]$_ -notlike '#*' -and [string]$_ -ne 'Repo' } | Sort-Object | ForEach-Object { if ($o[$_] -is [bool]) { "-$_" } else { "-$_ $($o[$_])" } })
        if (-not (Test-SamePath ([string]$o['#script']) $pinned)) { $line = "the task runs $($o['#script']), not the pinned copy ${pinned}: run update-pc.ps1 register" }
        elseif ([string]$o['#command'] -ne 'update') { $line = "the task runs update-pc.ps1 $($o['#command']), not update: run update-pc.ps1 register" }
        elseif ($extra.Count) { $line = "the task runs with $($extra -join ', '), which the launcher does not carry: run update-pc.ps1 register" }
      }
    }
    if ($line) { $line = "the scheduled task was not moved to the hidden launcher: $line" }
    else {
      # the times first; pinned.json changes only once the task is registered (a failure changes nothing)
      $oldAt = [string](Get-Field $pin 'dailyAt' '')
      $w = Get-Field $pin 'dailyTimes'
      if ($null -ne $w -and [string]@($w)[0] -eq $oldAt) { $oldAt = @($w) -join ',' }
      $times = @(Get-PinTimes $pin)
      $at = $times -join ','
      $local = @(Get-DailyLocal $times)
      $was = (Get-TaskCommand $task).source
      $launcher = Get-HiddenLauncherPath
      $backup = Save-LauncherBackup $launcher           # throws before anything is written when it cannot be read
      Write-TaskLauncher $pinned
      Register-HiddenTask $me $pinned $local
      $registered = $true
      Set-PinTimes $pin $times; Write-JsonAtomic $pj $pin
      $out = @("The scheduled task now starts hidden: wscript.exe //B $launcher (it was $was).",
        "  kept: -Repo $([string]$o['Repo']) and the pinned copy $pinned; the triggers, user and settings are register's own (they replace the old ones)")
      if ($oldAt -and $oldAt -ne $at) { $out += "  daily checks: $(Format-DailyTimes $times) New York time (it was $oldAt; Anthony 2026-10-23: twice a day, at 09:00 and 17:00, and at sign-in)" }
      else { $out += "  daily checks: $(Format-DailyTimes $times) New York time" }
      Write-Log "the scheduled task moved to the hidden launcher by $By; daily at $(Format-DailyTimes $times) New York time (it was $oldAt); kept -Repo $([string]$o['Repo'])"
      return $out
    }
  } catch {
    $line = "the scheduled task was not moved to the hidden launcher: $($_.Exception.Message)"
    # a failed move changes nothing: the launcher this attempt wrote goes (or is put back as it was); pinned.json was not touched
    if (-not $registered -and $backup) {
      try { Restore-LauncherBackup $backup } catch { $line += " (the launcher $launcher could not be put back: $($_.Exception.Message))" }
    }
  }
  Write-Log $line 'WARN'
  return @("$line. update-pc.ps1 register moves it.")
}

# The task's user (Principal.UserId), '' when it has none
function Get-TaskUserId($Task) {
  $p = $Task.PSObject.Properties['Principal']
  if (-not $p -or -not $p.Value) { return '' }
  $u = $p.Value.PSObject.Properties['UserId']
  if (-not $u) { return '' }
  return [string]$u.Value
}

# The task's logon type (Principal.LogonType: Interactive, S4U, Password, ...), '' when it has none. register makes it
# Interactive (only while signed in, no password stored); the move and the trigger changes refuse any other by name (review
# C3 of #68, as Bot-Lab's Get-PrincipalProblem).
function Get-TaskLogonType($Task) {
  $p = $Task.PSObject.Properties['Principal']
  if (-not $p -or -not $p.Value) { return '' }
  $l = $p.Value.PSObject.Properties['LogonType']
  if (-not $l -or $null -eq $l.Value) { return '' }
  return [string]$l.Value
}
function Get-LogonTypeText([string]$Type) {
  if (-not $Type) { return "the task's logon type cannot be read" }
  return "the task runs with logon type $Type, not Interactive (only while signed in)"
}

# The same Windows user: DOMAIN\user and user name the same one when the other side has no domain part
function Test-SameUser([string]$A, [string]$B) {
  if (-not $A -or -not $B) { return $false }
  if ($A -eq $B) { return $true }
  if ($A.Contains('\') -and $B.Contains('\')) { return $false }
  return (($A -split '\\')[-1] -eq ($B -split '\\')[-1])
}

# The task's own run moves a task behind a hand-made launcher (a .vbs in C:\SchwabDesk_bulk\hidden, as WORK and HOME
# made theirs on 2026-10-22) to this tool's own launcher (Anthony 2026-10-23: automatic on every PC, no hand step):
# Invoke-TaskMigration, exactly as -InstallChartBridge (the -Repo kept and nothing else to keep, refused by name
# otherwise; not elevated; the task's own user; the task runs the pinned copy), and only when this run is the pinned
# copy. The hand-made .vbs stays on disk. A plain powershell.exe task still moves only at -InstallChartBridge or register.
# A refusal or failure changes nothing and logs one WARN line naming why. Returns that line, or the move's ('' when it
# had nothing to do).
function Invoke-AutoTaskMigration {
  if ($env:OS -ne 'Windows_NT') { return '' }
  try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task -or (Get-TaskLauncherPath $task)) { return '' }
    $cmd = Get-TaskCommand $task
    if (-not $cmd.launcher -or -not (Test-HandLauncher $cmd.launcher)) { return '' }
    if (-not (Test-SamePath $script:UpdaterSelf (Join-Path $script:P.Bin 'update-pc.ps1'))) { return '' }   # a run by hand from the clone
  } catch { return '' }
  return (@(Invoke-TaskMigration "the task's own run") -join ' ')
}

# A hand-made launcher: a .vbs in C:\SchwabDesk_bulk\hidden (the tests point HandLauncherDir elsewhere)
function Test-HandLauncher([string]$Path) {
  if ($Path -notmatch '(?i)\.vbs$') { return $false }
  return (Test-SamePath (Split-Path -Parent $Path) $script:HandLauncherDir)
}

# The automatic run never changes the task's action or its pinned copy (they stay as Anthony left them), except the move
# above from a hand-made launcher: it only says so.
function Write-TaskStartWarning {
  if ($env:OS -ne 'Windows_NT') { return }
  try {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t -and -not (Get-TaskLauncherPath $t)) { Write-Log 'the task still starts without the hidden launcher: it is migrated at the next -InstallChartBridge (unless it is refused there; see its output) or update-pc.ps1 register' 'WARN' }
  } catch { }
}

function Invoke-Register {
  if ($env:OS -ne 'Windows_NT') { return (Write-Verdict $false 'register works on Windows only') }
  $pre = Test-Preflight
  if ($pre) { return (Write-Verdict $false $pre) }
  $user = Get-CurrentUserName
  $elevated = Test-Elevated
  $keep = Resolve-TaskOptions (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
  if ($keep.error) { return (Write-Verdict $false "not registered: $($keep.error)") }
  foreach ($n in $keep.notes) { Write-Host "keeping:      $n" }
  try { $times = @(Get-DailyTimes $DailyAt) } catch { return (Write-Verdict $false "not registered: -DailyAt $($DailyAt -join ','): $($_.Exception.Message)") }
  $local = @(Get-DailyLocal $times)
  # the launcher first (written and read back), then the task, then the pin (1.39.1; below): a launcher that cannot be
  # written changes nothing (review N2, 2026-10-23: the one before is put back byte for byte); the launcher names
  # updater\bin\update-pc.ps1, where the pin puts the copy
  $want = Join-Path $script:P.Bin 'update-pc.ps1'
  $launcher = Get-HiddenLauncherPath
  try { $backup = Save-LauncherBackup $launcher } catch { return (Write-Verdict $false "not registered, nothing changed: the launcher $launcher cannot be read ($($_.Exception.Message))") }
  try { Write-TaskLauncher $want }
  catch {
    $why = $_.Exception.Message
    try { Restore-LauncherBackup $backup } catch { $why += " (the launcher $launcher could not be put back: $($_.Exception.Message))" }   # a read-back that failed wrote it
    return (Write-Verdict $false "not registered, nothing changed: $why")
  }
  # 1.39.1 (the hidden-register review): the task first, then the pinned copy and pinned.json, so a register that fails
  # (Access is denied, a busy updater, main that cannot be staged) leaves the pin and its daily times as they were and puts
  # the launcher back byte for byte
  $done = @{ task = $false }
  try { $pinned = Invoke-PinForTask $DailyAt { Register-HiddenTask $user $want $local; $done.task = $true } }
  catch {
    $why = $_.Exception.Message
    if ($done.task) { return (Write-Verdict $false "the task is registered, but the copy it runs was not pinned: $why. Run update-pc.ps1 register again") }
    try { Restore-LauncherBackup $backup } catch { $why += " (the launcher $launcher could not be put back: $($_.Exception.Message))" }
    return (Write-Verdict $false "not registered, nothing changed (the pinned copy, pinned.json and the task as they were): $why")
  }
  if ([IO.Path]::GetFullPath($pinned) -ne [IO.Path]::GetFullPath($want)) { return (Write-Verdict $false "the pinned copy is $pinned, not ${want}: run update-pc.ps1 register again") }
  $t = Get-ScheduledTask -TaskName $TaskName
  $when = "at sign-in (after 2 minutes) and daily at $(Format-DailyTimes $times) New York time, $(Format-DailyTimes @($local | ForEach-Object { $_.ToString('HH:mm', [Globalization.CultureInfo]::InvariantCulture) })) on this PC's clock"
  Write-Log "registered the scheduled task '$TaskName': $when, started hidden by $(Get-HiddenLauncherPath)"
  if ($elevated) {
    $warn = "this window is elevated (Run as administrator). The task's own run (not elevated) may then be refused when it moves the daily checks for DST or a time zone change, every day. Run update-pc.ps1 register again from a normal (not elevated) PowerShell window"
    Write-Log "register: $warn" 'WARN'
    Write-Host "WARNING: $warn."
  }
  Write-Host "The task runs $pinned (a copy; it changes only when you run register again or -InstallChartBridge)."
  Write-Host "It starts hidden: wscript.exe //B (no WScript error dialog) runs $(Get-HiddenLauncherPath), which runs Windows PowerShell with no window."
  Write-Host "Each run works out $(Format-DailyTimes $times) New York time again and moves the daily checks if this PC's clock drifted from them (time zone or DST)."
  return (Write-Verdict ($null -ne $t) "scheduled task '$TaskName' registered: $when ($($t.State))")
}

# unregister's work (the tests run it with the ScheduledTasks commands stubbed): the task, then its launcher.
function Unregister-HiddenTask {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $named = Get-TaskLauncherPath $task
  if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Log "removed the scheduled task '$TaskName'"
  }
  foreach ($f in @(Remove-HiddenLauncher @((Get-HiddenLauncherPath), $named))) { Write-Log "removed the task's launcher $f" }
}

function Invoke-Unregister {
  if ($env:OS -ne 'Windows_NT') { return (Write-Verdict $false 'unregister works on Windows only') }
  Unregister-HiddenTask
  return (Write-Verdict $true "no scheduled task '$TaskName' now")
}

function Invoke-Main {
  $repoDir = $Repo
  $pinFile = Join-Path (Split-Path -Parent $script:UpdaterSelf) 'pinned.json'
  if (-not $repoDir -and (Test-Path $pinFile)) { $repoDir = [string](Get-Field (Read-JsonFile $pinFile) 'repo' '') }   # the pinned copy knows its clone
  Initialize-Paths $repoDir
  $cmd = $Command
  if ($InstallChartBridge) { $cmd = 'install-chartbridge' }
  $bad = Test-PinnedSelf
  if ($bad) { Write-Log "STOP: $bad" 'ERROR'; Write-StopRecord $bad; return (Write-Verdict $false $bad) }
  try {
    switch ($cmd) {
      'repair' { return (Invoke-Repair) }
      'status' { return (Invoke-Status) }
      'check' { return (Invoke-Update -DryRun) }
      'update' { return (Invoke-Update) }
      'rollback' { return (Invoke-Rollback) }
      'pause' { return (Invoke-Pause) }
      'resume' { return (Invoke-Resume) }
      'register' { return (Invoke-Register) }
      'unregister' { return (Invoke-Unregister) }
      'install-chartbridge' { return (Invoke-InstallChartBridge) }
    }
  } catch {
    Write-Log "$cmd failed: $($_.Exception.Message)" 'ERROR'
    return (Write-Verdict $false "$cmd failed: $($_.Exception.Message)")
  }
}

if (-not $NoRun) { exit (Invoke-Main) }
