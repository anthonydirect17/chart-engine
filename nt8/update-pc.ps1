<#
.SYNOPSIS
  Keeps this trading PC's chart page up to date, and gets a new ChartBridge ready for Anthony to install by hand.

.DESCRIPTION
  Run from the chart-engine clone (HOME, the laptop, WORK):
    powershell -NoProfile -ExecutionPolicy Bypass -File nt8\update-pc.ps1 <command>
  The scheduled task runs a pinned copy, updater\bin\update-pc.ps1, that changes only when Anthony runs register or
  -InstallChartBridge. The automatic path never moves the clone: it fetches, and stages from git objects.

  Commands:
    status                what is installed, what is waiting, and why (reads only; asks ChartBridge's /diag)
    check                 dry run: fetches main and says what `update` would do; changes nothing
    update                the automatic path (the scheduled task runs this): installs the newest commit on main
                          whose CI is green on ubuntu-latest and windows-latest, only when its page works with the
                          ChartBridge compiled on this PC; stages a new ChartBridge but never installs it
    -InstallChartBridge   run by Anthony while flat: copies the staged add-on files (and the matching page), then
                          Anthony presses F5 in the NinjaScript Editor while flat
    rollback              puts the previous page files back (and skips that commit until a newer one is on main)
    repair                page files only, never ChartBridge: finishes or undoes a cut-off install, or writes a whole
                          page from staged\, previous\ or the clone's page files
    pause / resume        a manual switch for the automatic path (off by default)
    register / unregister the scheduled task for this Windows user: at sign-in, and daily at -DailyAt (New York
                          time, 17:05 by default: futures are closed from 17:00 to 18:00 ET)

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
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('status', 'check', 'update', 'rollback', 'repair', 'pause', 'resume', 'register', 'unregister', 'install-chartbridge')]
  [string]$Command = 'status',
  [switch]$InstallChartBridge,
  [switch]$Yes,
  # The daily check, in New York time (Anthony, 2026-09-30: 17:05, inside the 17:00 to 18:00 ET futures break).
  [ValidatePattern('^([01][0-9]|2[0-3]):[0-5][0-9]$')]
  [string]$DailyAt = '17:05',
  [string]$TaskName = 'ChartEngine Updater',
  # The clone, for the pinned copy in updater\bin that the scheduled task runs (register passes it).
  [string]$Repo = '',
  # Tests only: load the functions without running a command.
  [switch]$NoRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:UpdaterSelf = $MyInvocation.MyCommand.Path
$script:RequiredChecks = @('unit (ubuntu-latest)', 'unit (windows-latest)')   # .github/workflows/test.yml
$script:GoodConclusions = @('success', 'neutral', 'skipped')
$script:Remote = 'origin'
$script:Branch = 'main'
$script:ManifestPath = 'nt8/install-files.json'
$script:CompatPath = 'live/COMPAT.json'
$script:SelfPath = 'nt8/update-pc.ps1'
$script:VersionFile = 'update.json'          # the one file the updater writes into www (the page polls it)
$script:LogMaxBytes = 1000000
$script:LogKeep = 3
$script:AddOnWriteAllowed = $false             # only Invoke-InstallChartBridge sets it, after Anthony confirms
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
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
  }
}

function Get-LocalPath([string]$Root, [string]$Rel) {
  return (Join-Path $Root ($Rel.Replace('/', [IO.Path]::DirectorySeparatorChar)))
}

# ------------------------------------------------------------------------------------------------ small helpers

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
    try { $p.Kill() } catch { }
    return @{ code = -1; out = ''; err = "timed out after $TimeoutSec s" }
  }
  $p.WaitForExit()
  return @{ code = $p.ExitCode; out = $out.Result; err = $err.Result }
}

function Get-GitExe {
  $c = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  return $c.Source
}

# Every git call of this tool goes through here. Only subcommands that read, or fetch origin into
# refs/remotes, are allowed: nothing here can move Anthony's clone (no checkout, merge, pull, reset ...).
$script:GitAllowed = @('fetch', 'rev-parse', 'show', 'cat-file', 'archive', 'remote', 'symbolic-ref', 'rev-list', 'merge-base', 'hash-object', 'ls-tree')

function Invoke-Git([string[]]$ArgList, [int]$TimeoutSec = 120) {
  if ($script:GitAllowed -notcontains $ArgList[0]) { throw "git $($ArgList[0]) is not allowed in update-pc.ps1" }
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
  Remove-Item -Force $zip
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
# them, index.html last. A page loaded in the middle then gets old files with new dependencies, never the reverse.
function Get-PageOrder([string[]]$Files) {
  $rank = {
    param($f)
    if ($f -eq 'index.html') { return 9 }
    if ($f -eq 'live.js') { return 6 }
    if ($f -eq 'update-notice.js') { return 7 }
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
  $State['page'] = @{ commit = $t['commit']; version = $t['version']; build = $t['build']; files = @($t['files']); installedAt = (Get-NowMs); how = $How }
  if ($J['skip']) { $State['skipCommit'] = $J['skip'] }
  Save-State $State
  Invoke-CrashPoint 'after-state'
  if ($J['then'] -eq 'promote' -and (Test-Path "$($script:P.PrevNext).tmp")) { Complete-PageCopy "$($script:P.PrevNext).tmp" $script:P.Previous }
  Write-UpdatePage $State['page'] ''
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
  return @{ compiled = $Compiled.version; compiledFrom = $Compiled.source; staged = $sv; ready = $ready; copied = $copied }
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
    $CbPart = [ordered]@{ compiled = (Get-Field $CbPart 'compiled'); ready = (Get-Field $CbPart 'ready'); copied = (Get-Field $CbPart 'copied') }
  }
  $doc = [ordered]@{
    schema = 1
    page = [ordered]@{ version = (Get-Field $Page 'version'); build = (Get-Field $Page 'build'); commit = (Get-Field $Page 'commit'); installedAt = (Get-Field $Page 'installedAt' 0); state = $PageState }
    chartBridge = $CbPart
  }
  $text = ConvertTo-Json -InputObject $doc -Depth 6
  if ((Test-Path -LiteralPath $path) -and ([IO.File]::ReadAllText($path, $script:Utf8) -eq $text)) { return }
  Write-TextAtomic $path $text
}

function Write-UpdatePage($Page, [string]$PageState) { Write-UpdateDoc $Page $PageState $null }

function Write-UpdateJson($State, $Notice) {
  $cb = [ordered]@{ compiled = $Notice.compiled; ready = $Notice.ready; copied = $Notice.copied }
  # while a swap is open (cut off, or failed and not undone) the page part says so, never "installed"
  $j = Read-JsonFile $script:P.Journal
  if ($j) {
    $t = $j['target']
    Write-UpdateDoc @{ version = $t['version']; build = $t['build']; commit = $t['commit']; installedAt = (Get-Field $j 'startedAt' 0) } 'installing' $cb
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
  }
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
function Get-CloneNote {
  $b = Invoke-Git @('symbolic-ref', '-q', '--short', 'HEAD') 30
  $branch = 'a detached HEAD'; if ($b.code -eq 0 -and $b.out.Trim()) { $branch = $b.out.Trim() }
  $n = Invoke-Git @('rev-list', '--count', "HEAD..refs/remotes/$($script:Remote)/$($script:Branch)") 30
  $behind = ''; if ($n.code -eq 0 -and $n.out.Trim() -ne '0') { $behind = ", $($n.out.Trim()) commits behind origin/main (git pull when you want; the task does not use the clone's files)" }
  return "on $branch$behind"
}

function New-Result { return @{ outcome = ''; reason = ''; target = $null; ci = $null; stage = $null; compiled = $null; recovered = $null } }

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
  $f = Invoke-Git @('fetch', '--quiet', $script:Remote, $script:Branch) 180
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

$script:StopOutcomes = @('blocked', 'fetch_failed', 'ci_unknown', 'stage_failed', 'cb_unknown', 'install_failed', 'interrupted')

function Complete-Run($State, $Result) {
  $lvl = 'INFO'; if ($script:StopOutcomes -contains $Result.outcome) { $lvl = 'WARN' }
  if ($Result.recovered) { $Result.reason = "(an interrupted page install was $($Result.recovered) first) " + $Result.reason }
  Write-Log "$($Result.outcome): $($Result.reason)" $lvl
  if ($null -eq $Result.compiled) { $Result.compiled = @{ version = $null; source = 'none'; detail = 'not asked' } }
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
  if (-not $DryRun) { Sync-DailyTrigger }
  $lock = Enter-Lock
  if (-not $lock) { return (Write-Verdict $false 'another update-pc.ps1 run is working; try again in a minute') }
  try {
    $state = Read-State
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
  $state = Read-State
  $c = Get-CompiledChartBridge $state
  if ($c.source -eq 'diag' -and (Test-Path $script:P.Dir)) {
    # keep what /diag said, so a page waiting for F5 installs on the next run even if NinjaTrader is closed then
    $lock = Enter-Lock
    if ($lock) { try { $s2 = Read-State; $s2['chartBridge'] = $state['chartBridge']; Save-State $s2 } finally { $lock.Dispose() } }
  }
  $n = Get-ChartBridgeNotice $state $c
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
  if (Get-Field $lr 'at') { Write-Host "last run:     $(Get-Field $lr 'outcome'): $(Get-Field $lr 'reason')" }
  if (Get-Field $state 'skipCommit') { Write-Host "skipping:     $(Get-Short (Get-Field $state 'skipCommit')) (rolled back by hand)" }
  if (Get-Field $state 'pendingPage') { Write-Host "page waiting: $(Get-Field $state['pendingPage'] 'version') for ChartBridge $(Get-Field $state['pendingPage'] 'needs') (installs on the first run after F5)" }
  if (Test-Path $script:P.Journal) { Write-Host 'interrupted:  a page install was cut off; the next update finishes or undoes it first (or, when flat: update-pc.ps1 repair, page files only)' }
  $pin = Read-JsonFile (Join-Path $script:P.Bin 'pinned.json')
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
  $pre = Test-Preflight
  if ($pre) { return (Write-Verdict $false $pre) }
  if (-not $c.version) { return (Write-Verdict $false "ChartBridge's version is not known: open NinjaTrader so ChartBridge runs, then run status again") }
  return (Write-Verdict $true "ChartBridge $($c.version) ($($c.source))")
}

function Invoke-Rollback {
  $pre = Test-Preflight
  if ($pre) { return (Write-Verdict $false $pre) }
  $lock = Enter-Lock
  if (-not $lock) { return (Write-Verdict $false 'another update-pc.ps1 run is working; try again in a minute') }
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

function Install-AddOnFiles($Stage) {
  if (-not $script:AddOnWriteAllowed) { throw 'refused: add-on (.cs) files are only copied by update-pc.ps1 -InstallChartBridge, after Anthony confirms he is flat' }
  if (-not (Test-Path $script:P.AddOns)) { New-Item -ItemType Directory -Force -Path $script:P.AddOns | Out-Null }
  $names = @(Get-Field $Stage 'addonFiles' @())
  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
  $backup = Join-Path $script:P.PrevAddOns $stamp
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  foreach ($n in $names) {
    $cur = Join-Path $script:P.AddOns $n
    if (Test-Path -LiteralPath $cur) { Copy-Item -LiteralPath $cur -Destination (Join-Path $backup $n) -Force }
  }
  Get-ChildItem -Directory $script:P.PrevAddOns | Sort-Object Name -Descending | Select-Object -Skip 3 | ForEach-Object { Remove-Dir $_.FullName }
  # all new files first under names NinjaTrader does not compile (.upd-tmp), then the replaces back to back
  foreach ($n in $names) {
    Copy-Item -LiteralPath (Join-Path (Join-Path $script:P.Staged 'addons') $n) -Destination (Join-Path $script:P.AddOns "$n.upd-tmp") -Force
  }
  foreach ($n in $names) { Move-FileAtomic (Join-Path $script:P.AddOns "$n.upd-tmp") (Join-Path $script:P.AddOns $n) }
  return $backup
}

function Invoke-InstallChartBridge {
  $pre = Test-Preflight -NoWwwOk
  if ($pre) { return (Write-Verdict $false $pre) }
  $lock = Enter-Lock
  if (-not $lock) { return (Write-Verdict $false 'another update-pc.ps1 run is working; try again in a minute') }
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
    try { $backup = Install-AddOnFiles $stage } finally { $script:AddOnWriteAllowed = $false }
    # recorded at once: whatever happens next, the notice, status and the F5 bookkeeping know the files were replaced
    $state['chartBridge']['installed'] = @{ version = $sv; commit = (Get-Field $stage 'commit'); at = (Get-NowMs); confirmed = $false }
    $state['chartBridge']['toastedFor'] = $sv
    Save-State $state
    Write-Log "ChartBridge $sv copied into $($script:P.AddOns) from $(Get-Short (Get-Field $stage 'commit')) by hand (-InstallChartBridge); the files it replaced are in $backup"
    # the scheduled task's own copy of this updater follows the commit Anthony just installed (never an older one)
    $pinNote = ''
    try { $pinNote = Update-PinnedFromStage $stage } catch { $pinNote = "the task's updater was not changed ($($_.Exception.Message))"; Write-Log $pinNote 'WARN' }
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
    Write-Host 'Then reload the chart page when flat. The files replaced are kept in:'
    Write-Host "  $backup"
    $tail = ''; if ($pageLater) { $tail = '; the page follows on the next update' }
    return (Write-Verdict $true "ChartBridge $sv copied: open the NinjaScript Editor and press F5 while flat$tail")
  } finally { $lock.Dispose() }
}

# update-pc.ps1 repair (page files only, never ChartBridge): finish or undo a cut-off install; if neither is possible,
# write a whole page from staged\ (when it works with the ChartBridge here), else previous\, else the clone's page
# files (the www part of its install-files.json only), through the same journaled swap.
function Invoke-Repair {
  $pre = Test-Preflight -NoWwwOk
  if ($pre) { return (Write-Verdict $false $pre) }
  $lock = Enter-Lock
  if (-not $lock) { return (Write-Verdict $false 'another update-pc.ps1 run is working; try again in a minute') }
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
    if (-not $target) {
      # the clone's page files, laid out as www in a folder of our own (its add-on files are never read)
      $m = Read-JsonFile (Join-Path (Join-Path $script:P.Repo 'nt8') 'install-files.json')
      Test-Manifest $m
      $tmp = Join-Path $script:P.Dir 'repair-page'
      Remove-Dir $tmp
      $files = @()
      foreach ($w in @(Get-Field $m 'www' @())) {
        $to = Get-LocalPath $tmp ([string]$w['to'])
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
        Copy-Item -LiteralPath (Get-LocalPath $script:P.Repo ([string]$w['from'])) -Destination $to -Force
        $files += [string]$w['to']
      }
      $head = (Invoke-Git @('rev-parse', 'HEAD') 30).out.Trim()
      $target = @{ source = $tmp; build = (Get-BuildId $tmp $files); files = $files; commit = $head; version = ''; from = 'the clone' }
    }
    Write-Log "repair: writing the page from $($target.from) (build $($target.build))$(if ($err) { " after: $err" })" 'WARN'
    Invoke-Swap $state $target $null '' ''
    Remove-Dir (Join-Path $script:P.Dir 'repair-page')
    $r = New-Result
    $r.outcome = 'repaired'; $r.reason = "page files written from $($target.from) (build $($target.build)); ChartBridge untouched"
    $r.compiled = $compiled
    [void](Complete-Run $state $r)
    return (Write-Verdict $true "$($r.reason). Reload the page when flat.")
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
# (2026-09-30): check once at startup, then once a day.
#   - At sign-in, after two minutes: the "startup" check (an at-startup trigger needs admin or SYSTEM).
#   - Daily at -DailyAt New York time (17:05), converted to this PC's clock when registering: futures are closed from
#     17:00 to 18:00 ET, so the check, and any brief console flash, never lands while Anthony trades.
#   - No "run as soon as possible after a missed start" (StartWhenAvailable): Task Scheduler would run a missed 17:05
#     whenever the PC is next awake, at any hour, often inside the trading day. The sign-in trigger already covers a PC
#     that was off; one that slept through 17:05 checks the next day.
# Never two runs at once (IgnoreNew), 30 minutes at most. It runs Windows PowerShell with -File.
function Get-TaskArguments([string]$Script, [string]$RepoDir) {
  return ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + (Format-Arg $Script) + ' update -Repo ' + (Format-Arg $RepoDir))
}

# The copy of this updater the scheduled task runs: updater\bin\update-pc.ps1, always the file of a CI-green commit on
# main (checked against that commit's git blob). It changes only when Anthony runs register or -InstallChartBridge.
# pinned.json keeps its commit, blob, sha256, the clone and the daily time; every run from it checks the sha256.
function Install-PinnedUpdater([string]$Source, [string]$Commit, [string]$Blob, [string]$From) {
  New-Item -ItemType Directory -Force -Path $script:P.Bin | Out-Null
  $dest = Join-Path $script:P.Bin 'update-pc.ps1'
  if ([IO.Path]::GetFullPath($Source) -ne [IO.Path]::GetFullPath($dest)) {
    Copy-Item -LiteralPath $Source -Destination "$dest.upd-tmp" -Force
    Move-FileAtomic "$dest.upd-tmp" $dest
  }
  $old = Read-JsonFile (Join-Path $script:P.Bin 'pinned.json')
  $daily = [string](Get-Field $old 'dailyAt' '17:05')
  Write-JsonAtomic (Join-Path $script:P.Bin 'pinned.json') @{ commit = $Commit; blob = $Blob; from = $From; at = (Get-NowMs); sha256 = (Get-FileSha256 $dest); repo = $script:P.Repo; dailyAt = $daily }
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
  foreach ($c in @($State['ciGreen'])) {
    if (-not $c) { continue }
    $b = (Get-CommitBlobs $c @($script:SelfPath))[$script:SelfPath]
    if ($b -and $b -eq $mine) { return @{ file = $script:UpdaterSelf; commit = $c; blob = $b; note = "this file, the same as in $(Get-Short $c) (green on main)" } }
  }
  throw "nothing to pin: main could not be staged ($($r.outcome): $($r.reason)), and this update-pc.ps1 is not the file of a commit seen green on main (a branch or a local edit?)"
}

# The pinned copy checks itself at every run: a changed file does nothing and says STOP in the log.
function Test-PinnedSelf {
  $pinFile = Join-Path (Split-Path -Parent $script:UpdaterSelf) 'pinned.json'
  if (-not (Test-Path $pinFile)) { return $null }
  $pin = Read-JsonFile $pinFile
  if ((Get-FileSha256 $script:UpdaterSelf) -ne (Get-Field $pin 'sha256')) {
    return "the task's updater $($script:UpdaterSelf) changed since it was pinned; nothing done. Run update-pc.ps1 register from the clone to pin a checked copy again"
  }
  return $null
}

# The daily check is a local time on this PC. At every run (sign-in and daily), 17:05 New York is worked out again for
# today, and the trigger is moved when it drifted (a time zone change, or DST dates that differ from New York's).
function Sync-DailyTrigger {
  if ($env:OS -ne 'Windows_NT') { return }
  try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { return }
    $daily = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskDailyTrigger' })
    $others = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -ne 'MSFT_TaskDailyTrigger' })
    if ($daily.Count -ne 1) { return }
    $pin = Read-JsonFile (Join-Path $script:P.Bin 'pinned.json')
    $at = [string](Get-Field $pin 'dailyAt' '17:05')
    $want = ConvertFrom-NewYorkTime $at
    $have = ([datetime]$daily[0].StartBoundary).ToString('HH:mm')
    if ($have -eq $want.ToString('HH:mm')) { return }
    $new = New-ScheduledTaskTrigger -Daily -At $want
    Set-ScheduledTask -TaskName $TaskName -Trigger (@($others) + @($new)) | Out-Null
    Write-Log "the daily check moved from $have to $($want.ToString('HH:mm')) on this PC's clock ($at New York time)" 'WARN'
  } catch { Write-Log "the daily check time could not be checked ($($_.Exception.Message))" 'WARN' }
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

# register's first half (any system): pick a checked copy, pin it, remember the daily time. Returns the pinned path.
function Invoke-PinForTask([string]$At) {
  $lock = Enter-Lock
  if (-not $lock) { throw 'another update-pc.ps1 run is working; try again in a minute' }
  try {
    $state = Read-State
    $src = Get-PinSource $state
    Save-State $state
    $pinned = Install-PinnedUpdater $src.file $src.commit $src.blob 'register'
    $pj = Join-Path $script:P.Bin 'pinned.json'
    $pin = Read-JsonFile $pj; $pin['dailyAt'] = $At; Write-JsonAtomic $pj $pin
    Write-Host "pinning:      $($src.note)"
    return $pinned
  } finally { $lock.Dispose() }
}

function Invoke-Register {
  if ($env:OS -ne 'Windows_NT') { return (Write-Verdict $false 'register works on Windows only') }
  $pre = Test-Preflight
  if ($pre) { return (Write-Verdict $false $pre) }
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  try { $pinned = Invoke-PinForTask $DailyAt } catch { return (Write-Verdict $false "not registered: $($_.Exception.Message)") }
  $action = New-ScheduledTaskAction -Execute $ps -Argument (Get-TaskArguments $pinned $script:P.Repo) -WorkingDirectory $script:P.Bin
  $logon = New-ScheduledTaskTrigger -AtLogOn -User $user
  $logon.Delay = 'PT2M'
  $local = ConvertFrom-NewYorkTime $DailyAt
  $daily = New-ScheduledTaskTrigger -Daily -At $local
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $daily) -Principal $principal -Settings $settings -Force `
    -Description "Keeps the chart page in ChartBridge's www folder up to date (green commits on main only). Never installs ChartBridge. Log: $($script:P.Log)" | Out-Null
  $t = Get-ScheduledTask -TaskName $TaskName
  $when = "at sign-in (after 2 minutes) and daily at $DailyAt New York time, $($local.ToString('HH:mm')) on this PC's clock"
  Write-Log "registered the scheduled task '$TaskName': $when"
  Write-Host "The task runs $pinned (a copy; it changes only when you run register again or -InstallChartBridge)."
  Write-Host "Each run works out $DailyAt New York time again and moves the daily check if this PC's clock drifted from it (time zone or DST)."
  return (Write-Verdict ($null -ne $t) "scheduled task '$TaskName' registered: $when ($($t.State))")
}

function Invoke-Unregister {
  if ($env:OS -ne 'Windows_NT') { return (Write-Verdict $false 'unregister works on Windows only') }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Log "removed the scheduled task '$TaskName'"
  }
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
  if ($bad) { Write-Log "STOP: $bad" 'ERROR'; return (Write-Verdict $false $bad) }
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
