<#
.SYNOPSIS
  Keeps this trading PC's chart page up to date, and gets a new ChartBridge ready for Anthony to install by hand.

.DESCRIPTION
  Run from the chart-engine clone (HOME, the laptop, WORK):
    powershell -NoProfile -ExecutionPolicy Bypass -File nt8\update-pc.ps1 <command>

  Commands:
    status                what is installed, what is waiting, and why (reads only; asks ChartBridge's /diag)
    check                 dry run: fetches main and says what `update` would do; changes nothing
    update                the automatic path (the scheduled task runs this): installs the newest commit on main
                          whose CI is green on ubuntu-latest and windows-latest, only when its page works with the
                          ChartBridge compiled on this PC; stages a new ChartBridge but never installs it
    -InstallChartBridge   run by Anthony while flat: copies the staged add-on files (and the matching page), then
                          Anthony presses F5 in the NinjaScript Editor while flat
    rollback              puts the previous page files back (and skips that commit until a newer one is on main)
    pause / resume        a manual switch for the automatic path (off by default)
    register / unregister the scheduled task for this Windows user: at sign-in, and daily at -DailyAt (New York
                          time, 17:05 by default: futures are closed from 17:00 to 18:00 ET)

  Rules (Anthony, 2026-09-30):
    - The automatic path never writes a .cs file into bin\Custom\AddOns: the next F5 anyone pressed would compile it
      at a random moment, possibly with a position open. Only -InstallChartBridge does, after Anthony says he is flat.
    - config.txt and pin.txt in Documents\NinjaTrader 8\ChartBridge are this PC's own and are never touched.
    - The page files are written one by one through a temporary file and an atomic replace, so ChartBridge never
      serves half a file; an open page keeps its loaded code and only shows "Update ready: reload when flat".
    - Windows PowerShell 5.1 and git only. No PowerShell command strings: scripts run with -File.

  State and logs: Documents\NinjaTrader 8\ChartBridge\updater\ (state.json, status.json, update.log, staged\,
  previous\, previous-addons\, paused). Only update.json (versions, no secrets) is written into the served www folder.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('status', 'check', 'update', 'rollback', 'pause', 'resume', 'register', 'unregister', 'install-chartbridge')]
  [string]$Command = 'status',
  [switch]$InstallChartBridge,
  [switch]$Yes,
  # The daily check, in New York time (Anthony, 2026-09-30: 17:05, inside the 17:00 to 18:00 ET futures break).
  [ValidatePattern('^([01][0-9]|2[0-3]):[0-5][0-9]$')]
  [string]$DailyAt = '17:05',
  [string]$TaskName = 'ChartEngine Updater',
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
$script:VersionFile = 'update.json'          # the one file the updater writes into www (the page polls it)
$script:LogMaxBytes = 1000000
$script:LogKeep = 3
$script:AddOnWriteAllowed = $false             # only Invoke-InstallChartBridge sets it, after Anthony confirms
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)

# ------------------------------------------------------------------------------------------------ paths

function Initialize-Paths([string]$Repo, [string]$NtFolder) {
  if (-not $Repo) { $Repo = Split-Path -Parent (Split-Path -Parent $script:UpdaterSelf) }
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
  $psi.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'    # never wait for a login prompt
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

function Invoke-Git([string[]]$ArgList, [int]$TimeoutSec = 120) {
  $git = Get-GitExe
  if (-not $git) { return @{ code = -1; out = ''; err = 'git is not on PATH' } }
  return (Invoke-Native $git (@('-C', $script:P.Repo) + $ArgList) $TimeoutSec)
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
    $hit = @($Checks | Where-Object { (Get-Field $_ 'name') -eq $need })
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

# The ChartBridge compiled on this PC: /diag when it answers; otherwise what this tool recorded. Never a guess.
#   recorded = the last version /diag showed, and the version -InstallChartBridge copied. When the copy has not been
#   seen compiled yet (no F5 seen), the lower of the two counts: both could be the one running after a restart.
function Get-CompiledChartBridge($State) {
  $cbs = $State['chartBridge']
  $diag = Get-DiagVersion
  if ($diag.ok) {
    $cbs['diagVersion'] = $diag.version
    $cbs['diagSeenAt'] = Get-NowMs
    $inst = Get-Field $cbs 'installed'
    if ($inst -and (Get-Field $inst 'version') -eq $diag.version) { $inst['confirmed'] = $true }
    if (-not (ConvertTo-VersionOrNull $diag.version)) { return @{ version = $null; source = 'diag'; detail = "/diag says '$($diag.version)', not a version this tool can compare" } }
    return @{ version = $diag.version; source = 'diag'; detail = 'ChartBridge /diag' }
  }
  $seen = [string](Get-Field $cbs 'diagVersion' '')
  $inst = Get-Field $cbs 'installed'
  $instV = ''
  $confirmed = $false
  if ($inst) { $instV = [string](Get-Field $inst 'version' ''); $confirmed = [bool](Get-Field $inst 'confirmed' $false) }
  if ($instV -and $confirmed -and (ConvertTo-VersionOrNull $instV)) { return @{ version = $instV; source = 'recorded'; detail = "installed by this tool and seen compiled ($($diag.detail))" } }
  if ($instV -and $seen -and (ConvertTo-VersionOrNull $instV) -and (ConvertTo-VersionOrNull $seen)) {
    $low = $seen; if ((ConvertTo-VersionOrNull $instV) -lt (ConvertTo-VersionOrNull $seen)) { $low = $instV }
    return @{ version = $low; source = 'recorded'; detail = "copied $instV, F5 not seen yet; last seen compiled $seen; counting $low ($($diag.detail))" }
  }
  if ($seen -and -not $instV -and (ConvertTo-VersionOrNull $seen)) { return @{ version = $seen; source = 'recorded'; detail = "last seen in /diag ($($diag.detail))" } }
  if ($instV) { return @{ version = $null; source = 'none'; detail = "ChartBridge $instV was copied but never seen compiled, and $($diag.detail)" } }
  return @{ version = $null; source = 'none'; detail = "not known: $($diag.detail), and this tool has recorded no version yet" }
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
    if ($to -match '(^|/)\.\.(/|$)' -or $to -match '^[/\\]' -or $to -match ':' -or $to -match '\\') { throw "page target '$to' must stay inside www" }
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
  $paths = @($addons) + @($www | ForEach-Object { [string](Get-Field $_ 'from') }) | Select-Object -Unique
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
  Remove-Dir $src
  $stage = @{
    commit = $Info.commit; pageVersion = $Info.pageVersion; minChartBridge = $Info.minChartBridge
    chartBridgeVersion = $Info.chartBridgeVersion; pageFiles = $targets; addonFiles = $names
    build = (Get-BuildId (Join-Path $tmp 'page') $targets); stagedAt = (Get-NowMs)
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
  foreach ($n in @(Get-Field $Stage 'addonFiles' @())) { if (-not (Test-Path (Join-Path (Join-Path $script:P.Staged 'addons') $n))) { return $false } }
  return $true
}

# ------------------------------------------------------------------------------------------------ the page files

function Get-ManagedFiles($State, $Extra) {
  $list = @(Get-Field $State['page'] 'files' @()) + @($Extra) | Where-Object { $_ } | Select-Object -Unique
  return @($list)
}

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

# Write page files into www one by one: each through <name>.upd-tmp and an atomic replace, the page's scripts and
# styles first and index.html last. A page already open keeps running the code it loaded.
function Copy-PageFiles([string]$FromRoot, [string[]]$Files, [string[]]$Drop) {
  $ordered = @($Files | Where-Object { $_ -ne 'index.html' }) + @($Files | Where-Object { $_ -eq 'index.html' })
  foreach ($f in $ordered) {
    $dest = Get-LocalPath $script:P.Www $f
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    $tmp = "$dest.upd-tmp"
    Copy-Item -LiteralPath (Get-LocalPath $FromRoot $f) -Destination $tmp -Force
    Move-FileAtomic $tmp $dest
  }
  foreach ($f in @($Drop)) {
    if ($f -and $Files -notcontains $f) {
      $p = Get-LocalPath $script:P.Www $f
      if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
    }
  }
}

function Install-PageFiles($State, $Stage, [string]$Why) {
  $page = Join-Path $script:P.Staged 'page'
  $files = @(Get-Field $Stage 'pageFiles' @())
  if ((Get-BuildId $page $files) -ne (Get-Field $Stage 'build')) { throw 'the staged page files changed since staging; not installing them' }
  $old = Get-ManagedFiles $State $files
  $meta = @{ commit = (Get-Field $State['page'] 'commit'); version = (Get-Field $State['page'] 'version') }
  $tmp = Save-PageCopy $script:P.Previous $old $meta
  Complete-PageCopy $tmp $script:P.Previous
  try {
    Copy-PageFiles $page $files $old
  } catch {
    $err = $_.Exception.Message
    Write-Log "page install failed ($err); putting the previous files back" 'ERROR'
    $prev = Read-JsonFile (Join-Path $script:P.Previous 'previous.json')
    Copy-PageFiles (Join-Path $script:P.Previous 'page') @(Get-Field $prev 'files' @()) $files
    throw "page install failed and was undone: $err"
  }
  $State['page'] = @{
    commit = $Stage.commit; version = $Stage.pageVersion; build = $Stage.build; files = $files
    installedAt = (Get-NowMs); how = $Why
  }
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
function Write-UpdateJson($State, $Notice) {
  $pg = $State['page']
  $doc = [ordered]@{
    schema = 1
    page = [ordered]@{ version = (Get-Field $pg 'version'); build = (Get-Field $pg 'build'); commit = (Get-Field $pg 'commit'); installedAt = (Get-Field $pg 'installedAt' 0) }
    chartBridge = [ordered]@{ compiled = $Notice.compiled; ready = $Notice.ready; copied = $Notice.copied }
  }
  if (-not (Test-Path $script:P.Www)) { return }
  $path = Join-Path $script:P.Www $script:VersionFile
  $text = ConvertTo-Json -InputObject $doc -Depth 6
  if ((Test-Path -LiteralPath $path) -and ([IO.File]::ReadAllText($path, $script:Utf8) -eq $text)) { return }
  Write-TextAtomic $path $text
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

function Test-Preflight {
  if (-not (Get-GitExe)) { return 'git is not on PATH' }
  if (-not (Test-Path (Join-Path $script:P.Repo '.git'))) { return "$($script:P.Repo) is not a git clone" }
  if (-not (Test-Path $script:P.Nt)) { return "NinjaTrader 8 folder not found at $($script:P.Nt)" }
  if (-not (Test-Path $script:P.Www)) { return "ChartBridge's page folder is missing ($($script:P.Www)): run nt8\install.ps1 once (the setup)" }
  return $null
}

# Move the clone itself forward too (so this script and install.ps1 stay current), only when that is safe: on main,
# no changed tracked files, a fast forward. Otherwise it is left alone and the log says why.
function Update-Clone([string]$Target) {
  $b = Invoke-Git @('symbolic-ref', '-q', '--short', 'HEAD') 30
  if ($b.code -ne 0 -or $b.out.Trim() -ne $script:Branch) { return "the clone is not on $($script:Branch); left as it is" }
  $d = Invoke-Git @('status', '--porcelain', '--untracked-files=no') 60
  if ($d.code -ne 0 -or $d.out.Trim()) { return 'the clone has changed tracked files; left as it is' }
  $f = Invoke-Git @('merge', '--ff-only', '--quiet', $Target) 120
  if ($f.code -ne 0) { return "the clone could not fast forward ($(Get-LastLine $f.err)); left as it is" }
  return "the clone is at $(Get-Short $Target)"
}

function New-Result { return @{ outcome = ''; reason = ''; target = $null; ci = $null; stage = $null; compiled = $null } }

function Invoke-Pass([switch]$DryRun, [switch]$StageOnly, $State) {
  $r = New-Result
  $r.compiled = Get-CompiledChartBridge $State
  $pre = Test-Preflight
  if ($pre) { $r.outcome = 'blocked'; $r.reason = $pre; return $r }
  if (-not $DryRun -and -not $StageOnly -and (Test-Path $script:P.Paused)) {
    $r.outcome = 'paused'; $r.reason = "paused by hand ($($script:P.Paused)); run update-pc.ps1 resume to turn updates back on"; return $r
  }
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
    $r.outcome = "ci_$($ci.state)"
    $r.reason = "main is at $short; not installing: CI $($ci.state) ($($ci.detail))"
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
  Write-Log (Update-Clone $r.target)
  return $r
}

$script:StopOutcomes = @('blocked', 'fetch_failed', 'ci_unknown', 'stage_failed', 'cb_unknown', 'install_failed')

function Complete-Run($State, $Result) {
  $lvl = 'INFO'; if ($script:StopOutcomes -contains $Result.outcome) { $lvl = 'WARN' }
  Write-Log "$($Result.outcome): $($Result.reason)" $lvl
  $notice = Get-ChartBridgeNotice $State $Result.compiled
  if ($notice.ready -and (Get-Field $State['chartBridge'] 'toastedFor') -ne $notice.ready) {
    $msg = "ChartBridge $($notice.ready) is ready to install. When flat: update-pc.ps1 -InstallChartBridge, then F5 in the NinjaScript Editor."
    Write-Log $msg
    [void](Show-Toast 'ChartBridge update ready' $msg)
    $State['chartBridge']['toastedFor'] = $notice.ready
  }
  $State['lastRun'] = @{ at = (Get-NowMs); outcome = $Result.outcome; reason = $Result.reason; target = $Result.target }
  Save-State $State
  Write-UpdateJson $State $notice
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
  if (-not $lock) { return (Write-Verdict $false 'another update-pc.ps1 run is working; try again in a minute') }
  try {
    $state = Read-State
    $r = Invoke-Pass -DryRun:$DryRun -State $state
    if ($DryRun) {
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
  $n = Get-ChartBridgeNotice $state $c
  $pg = $state['page']
  Write-Host "clone:        $($script:P.Repo)"
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
  $lock = Enter-Lock
  if (-not $lock) { return (Write-Verdict $false 'another update-pc.ps1 run is working; try again in a minute') }
  try {
    $prev = Read-JsonFile (Join-Path $script:P.Previous 'previous.json')
    if (-not $prev -or @(Get-Field $prev 'files' @()).Count -eq 0) { return (Write-Verdict $false 'no previous page files are kept yet; nothing to roll back to') }
    $pfiles = @(Get-Field $prev 'files' @())
    if ((Get-BuildId (Join-Path $script:P.Previous 'page') $pfiles) -ne (Get-Field $prev 'build')) { return (Write-Verdict $false 'the kept previous files do not match their record; nothing changed') }
    $state = Read-State
    $cur = $state['page']
    $curFiles = Get-ManagedFiles $state $pfiles
    $meta = @{ commit = (Get-Field $cur 'commit'); version = (Get-Field $cur 'version') }
    $tmp = Save-PageCopy (Join-Path $script:P.Dir 'previous-next') $curFiles $meta
    Copy-PageFiles (Join-Path $script:P.Previous 'page') $pfiles $curFiles
    $rolledFrom = Get-Field $cur 'commit'
    Remove-Dir (Join-Path $script:P.Dir 'previous-next')
    Complete-PageCopy $tmp $script:P.Previous
    $state['page'] = @{ commit = (Get-Field $prev 'commit'); version = (Get-Field $prev 'version'); build = (Get-Field $prev 'build'); files = $pfiles; installedAt = (Get-NowMs); how = 'rollback' }
    if ($rolledFrom -and $rolledFrom -ne (Get-Field $prev 'commit')) { $state['skipCommit'] = $rolledFrom }
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
  foreach ($n in $names) {
    $dest = Join-Path $script:P.AddOns $n
    $tmp = "$dest.upd-tmp"          # not .cs: NinjaTrader never compiles it
    Copy-Item -LiteralPath (Join-Path (Join-Path $script:P.Staged 'addons') $n) -Destination $tmp -Force
    Move-FileAtomic $tmp $dest
  }
  return $backup
}

function Invoke-InstallChartBridge {
  $lock = Enter-Lock
  if (-not $lock) { return (Write-Verdict $false 'another update-pc.ps1 run is working; try again in a minute') }
  try {
    $state = Read-State
    $pre = Test-Preflight
    if ($pre) { return (Write-Verdict $false $pre) }
    $r = Invoke-Pass -StageOnly -State $state
    if ($r.outcome -ne 'staged') { Write-Host "main: $($r.outcome): $($r.reason)" }
    $stage = Read-JsonFile (Join-Path $script:P.Staged 'stage.json')
    if (-not $stage -or -not (Test-StagedIntact $stage)) { return (Write-Verdict $false 'nothing staged from a green commit yet; run update-pc.ps1 check to see why') }
    $compiled = Get-CompiledChartBridge $state
    $sv = [string](Get-Field $stage 'chartBridgeVersion')
    Write-Host "staged:       $(Get-Short (Get-Field $stage 'commit')): ChartBridge $sv, page $(Get-Field $stage 'pageVersion')"
    Write-Host "this PC:      ChartBridge $(if ($compiled.version) { $compiled.version } else { 'unknown' }) ($($compiled.detail))"
    if ($compiled.version -and $compiled.version -eq $sv) { Write-Host "ChartBridge $sv is already compiled here; this copies the same files again." }
    if (-not $Yes) {
      $answer = Read-Host "Install ChartBridge $sv now? Only while flat in every account. Type y to go on"
      if ($answer -ne 'y') { return (Write-Verdict $false 'nothing changed') }
    }
    $script:AddOnWriteAllowed = $true
    try { $backup = Install-AddOnFiles $stage } finally { $script:AddOnWriteAllowed = $false }
    Write-Log "ChartBridge $sv copied into $($script:P.AddOns) from $(Get-Short (Get-Field $stage 'commit')) by hand (-InstallChartBridge); the files it replaced are in $backup"
    if ((Get-BuildId $script:P.Www @(Get-Field $stage 'pageFiles' @())) -ne (Get-Field $stage 'build')) { Install-PageFiles $state $stage 'with ChartBridge (-InstallChartBridge)' }
    $state['chartBridge']['installed'] = @{ version = $sv; commit = (Get-Field $stage 'commit'); at = (Get-NowMs); confirmed = $false }
    $state['chartBridge']['toastedFor'] = $sv
    $r2 = New-Result
    $r2.outcome = 'chartbridge_copied'; $r2.reason = "ChartBridge $sv copied; waiting for F5"; $r2.target = $r.target
    $r2.compiled = $compiled
    [void](Complete-Run $state $r2)
    Write-Host ''
    Write-Host "Next, while flat: NinjaTrader > New > NinjaScript Editor > press F5 (compile)."
    Write-Host "Then open http://localhost:$(Get-ChartBridgePort)/diag and check that it says ""version"":""$sv"" (or run update-pc.ps1 status)."
    Write-Host 'Then reload the chart page. The files replaced are kept in:'
    Write-Host "  $backup"
    return (Write-Verdict $true "ChartBridge $sv copied: press F5 in the NinjaScript Editor while flat")
  } finally { $lock.Dispose() }
}

function Invoke-Pause {
  if (-not (Test-Path $script:P.Dir)) { New-Item -ItemType Directory -Force -Path $script:P.Dir | Out-Null }
  [IO.File]::WriteAllText($script:P.Paused, 'paused by hand ' + (Get-Date).ToString('s') + [Environment]::NewLine, $script:Utf8)
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
function Get-TaskArguments {
  return ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + (Format-Arg $script:UpdaterSelf) + ' update')
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

function Invoke-Register {
  if ($env:OS -ne 'Windows_NT') { return (Write-Verdict $false 'register works on Windows only') }
  $pre = Test-Preflight
  if ($pre) { return (Write-Verdict $false $pre) }
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $action = New-ScheduledTaskAction -Execute $ps -Argument (Get-TaskArguments) -WorkingDirectory $script:P.Repo
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
  Write-Host "If this PC's time zone changes, run register again to move the daily check."
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
  Initialize-Paths
  $cmd = $Command
  if ($InstallChartBridge) { $cmd = 'install-chartbridge' }
  try {
    switch ($cmd) {
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
