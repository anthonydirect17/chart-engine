# Tests for nt8/update-pc.ps1 (the per-PC updater). Plain PowerShell, no module needed: Windows PowerShell 5.1 on the
# Windows CI runner (the trading PCs' PowerShell), pwsh on Linux. test/pc-updater.test.js runs this file from
# `npm test`; the scheduled-task and file-sharing tests run on Windows only.
#
# A throwaway world: a bare "origin" repo made from this repo's own page and add-on files, a clone of it, and a fake
# NinjaTrader 8 folder (www with a file of Anthony's, config.txt and pin.txt, AddOns with an older ChartBridge).
# GitHub's CI answer and ChartBridge's /diag are stubbed. Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\pc-updater.tests.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $here
. (Join-Path (Join-Path $repoRoot 'nt8') 'update-pc.ps1') -NoRun
$ErrorActionPreference = 'Stop'

$script:Passed = 0; $script:Failed = 0; $script:Skipped = 0
$IsWin = ($env:OS -eq 'Windows_NT')

function Assert([bool]$Condition, [string]$What) { if (-not $Condition) { throw "expected: $What" } }
# A command's result is exactly one number (anything else would break `exit` in the real script)
function Assert-Code($Code, [int]$Want, [string]$What) { Assert (($Code -is [int]) -and $Code -eq $Want) "$What (got $(@($Code).Count) value(s): $($Code -join ', '))" }
function Test([string]$Name, [scriptblock]$Body) {
  try { & $Body; $script:Passed++; Write-Host "  ok   $Name" }
  catch { $script:Failed++; Write-Host "  FAIL $Name :: $($_.Exception.Message) $($_.InvocationInfo.PositionMessage)" }
}
function Skip([string]$Name, [string]$Why) { $script:Skipped++; Write-Host "  skip $Name ($Why)" }

# ---------------------------------------------------------------------------------------------- stubs

$script:FakeCi = 'success'
$script:FakeDiag = $null
$script:Toasts = @()
$script:RealGitHubJson = ${function:Invoke-GitHubJson}
$script:RealMove = ${function:Move-FileAtomic}
# A power loss (a laptop lid): from the crash point on, nothing more is written anywhere through the updater.
$script:CrashAt = ''; $script:PowerLost = $false
function Invoke-CrashPoint([string]$Name) { if ($script:CrashAt -and $script:CrashAt -eq $Name) { $script:PowerLost = $true; throw "SIMULATED POWER LOSS at $Name" } }
$script:HoldLiveJs = $false      # ChartBridge holding www\live.js past the retry (the reviewer's p4_icb)
$script:HoldAddOn = ''           # an add-on file held past the retry (the NinjaScript Editor; the reviewer's p5_addons)
$script:HoldRestore = $false     # and putting the old files back fails too
function Move-FileAtomic([string]$Source, [string]$Dest) {
  if ($script:PowerLost) { throw 'power is off' }
  if ($script:HoldLiveJs -and $Dest -like '*www*live.js') { throw 'sharing violation (ChartBridge holds live.js)' }
  if ($script:HoldAddOn -and $Source -like '*.upd-tmp' -and (Split-Path -Leaf $Dest) -eq $script:HoldAddOn) { throw "could not replace ${Dest}: the NinjaScript Editor holds it" }
  if ($script:HoldRestore -and $Source -like '*.upd-restore') { throw "could not replace ${Dest}: held (the put-back)" }
  & $script:RealMove $Source $Dest
}
# GitHub's API as the updater reads it: check runs and statuses for a commit (the real Get-CiState runs on these).
function Get-RepoSlug { return 'owner/chart-engine' }
function Invoke-GitHubJson([string]$Path) {
  if ($script:FakeCi -eq 'unknown') { throw (New-Object System.Net.WebException 'stub: no network') }
  if ($Path -match '/status\?') { return @{ statuses = @() } }
  $win = @{ success = @('completed', 'success'); pending = @('in_progress', $null); failure = @('completed', 'failure') }[$script:FakeCi]
  return @{ total_count = 3; check_runs = @(
      @{ name = 'unit (ubuntu-latest)'; status = 'completed'; conclusion = 'success'; app = @{ slug = 'github-actions' } },
      @{ name = 'unit (windows-latest)'; status = $win[0]; conclusion = $win[1]; app = @{ slug = 'github-actions' } },
      @{ name = 'deploy'; status = 'completed'; conclusion = 'success'; app = @{ slug = 'github-actions' } }) }
}
function Get-DiagVersion {
  if ($script:FakeDiag) { return @{ ok = $true; version = $script:FakeDiag; detail = 'stub /diag' } }
  return @{ ok = $false; version = $null; detail = 'stub: ChartBridge not running' }
}
function Show-Toast([string]$Title, [string]$Text) { $script:Toasts += $Text; return $true }
$script:Said = New-Object System.Collections.ArrayList   # what the commands printed (the tests read it)
function Write-Host { param([Parameter(ValueFromRemainingArguments = $true)]$Rest) [void]$script:Said.Add("$Rest"); if ("$Rest" -match '^\s+(ok|FAIL|skip) |^(OK|STOP):|^pc-updater') { Microsoft.PowerShell.Utility\Write-Host "$Rest" } }
function Get-Said { $t = ($script:Said -join "`n"); $script:Said.Clear(); return $t }

# ---------------------------------------------------------------------------------------------- the world

$tmpRoot = Join-Path ([IO.Path]::GetTempPath()) ('pcupd-' + [guid]::NewGuid().ToString('N').Substring(0, 10))
New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null
$origin = Join-Path $tmpRoot 'origin.git'
$src = Join-Path $tmpRoot 'src'
$clone = Join-Path $tmpRoot 'clone'
$nt = Join-Path $tmpRoot 'nt'

function G([string]$Dir, [string[]]$A) {
  $r = Invoke-Native (Get-GitExe) (@('-C', $Dir, '-c', 'user.name=Updater Test', '-c', 'user.email=updater-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false') + $A) 120
  if ($r.code -ne 0) { throw "git $($A -join ' '): $($r.err)" }
  return $r.out.Trim()
}
function Put([string]$Path, [string]$Text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}
function Get-Text([string]$Path) { return [IO.File]::ReadAllText($Path) }
function Get-Hash([string]$Path) { return (Get-FileSha256 $Path) }
# The same text as the commit: git archive writes line endings as this PC's git does (core.autocrlf on Windows), as a
# checkout for nt8\install.ps1 would.
function Get-TextSame([string]$A, [string]$B) { return ((Get-Text $A).Replace("`r`n", "`n") -eq (Get-Text $B).Replace("`r`n", "`n")) }
function Commit([string]$Message, [scriptblock]$Change) {
  & $Change
  [void](G $src @('add', '-A'))
  [void](G $src @('commit', '-q', '-m', $Message))
  [void](G $src @('push', '-q', 'origin', 'main'))
  return (G $src @('rev-parse', 'HEAD'))
}
function Set-CbVersion([string]$V) {
  $f = Join-Path (Join-Path $src 'nt8') 'ChartBridge.cs'
  Put $f ([regex]::Replace((Get-Text $f), 'public const string Version = "[^"]+"', "public const string Version = ""$V"""))
}
function Set-MinCb([string]$V) {
  $f = Join-Path (Join-Path $src 'live') 'COMPAT.json'
  Put $f ([regex]::Replace((Get-Text $f), '"minChartBridge": "[^"]+"', """minChartBridge"": ""$V"""))
}
function Get-AddOnsPrint { return ((Get-ChildItem -LiteralPath $script:P.AddOns -File | Sort-Object Name | ForEach-Object { $_.Name + ':' + (Get-Hash $_.FullName) }) -join ';') }
function Get-WwwFile([string]$Rel) { return (Get-LocalPath $script:P.Www $Rel) }
function Get-UpdateJson { return (Read-JsonFile (Join-Path $script:P.Www 'update.json')) }
function Run-Update { $state = Read-State; $r = Invoke-Pass -State $state; [void](Complete-Run $state $r); return $r }
function Rx([string]$Text) { return [regex]::Escape($Text) }
# The ChartBridge versions these tests use, counted from this repo's live/COMPAT.json minChartBridge, so a raise there
# moves them with it (written when it was 0.3.2: 0.3.1, 0.3.2, 0.3.3, 0.3.9, then 0.4.0 to 0.4.3). One below the page's
# minimum, the minimum, the PC's own (one above: compatible), a newer one with a page that needs it, the minor after.
$cbParts = @(((ConvertFrom-JsonText (Get-Text (Join-Path (Join-Path $repoRoot 'live') 'COMPAT.json')))['minChartBridge']).Split('.') | ForEach-Object { [int]$_ })
$cbMajor = $cbParts[0]; $cbMinor = $cbParts[1]; $cbPatch = $cbParts[2]
$vMin = "$cbMajor.$cbMinor.$cbPatch"
$vBelow = if ($cbPatch -gt 0) { "$cbMajor.$cbMinor.$($cbPatch - 1)" } elseif ($cbMinor -gt 0) { "$cbMajor.$($cbMinor - 1).99" } else { "$($cbMajor - 1).99.99" }
$vPc = "$cbMajor.$cbMinor.$($cbPatch + 1)"
# The newer ones are also counted from the ChartBridge this repo ships (nt8/ChartBridge.cs), so they are always newer than it (the
# test clone starts from this repo's files: a "newer" ChartBridge equal to the real one is no change; ChartBridge 0.6.9, CI of #71):
# $vNeeds is above both the minimum + 7 and the real version, in the real version's minor when it is the minimum's; the $vNext ones
# are in the minor after the higher of the two.
$realCb = [regex]::Match((Get-Text (Join-Path (Join-Path $repoRoot 'nt8') 'ChartBridge.cs')), 'public const string Version = "(\d+)\.(\d+)\.(\d+)"')
if (-not $realCb.Success) { throw 'the ChartBridge version constant was not found in nt8/ChartBridge.cs' }
$rMajor = [int]$realCb.Groups[1].Value; $rMinor = [int]$realCb.Groups[2].Value; $rPatch = [int]$realCb.Groups[3].Value
if ($rMajor -eq $cbMajor -and $rMinor -eq $cbMinor) { $vNeeds = "$cbMajor.$cbMinor.$([Math]::Max($cbPatch + 7, $rPatch + 1))"; $nMajor = $cbMajor; $nMinor = $cbMinor + 1 }
else { $vNeeds = "$rMajor.$rMinor.$($rPatch + 1)"; $nMajor = $rMajor; $nMinor = $rMinor + 1 }   # the real one is past the minimum's minor
$vNext0 = "$nMajor.$nMinor.0"; $vNext1 = "$nMajor.$nMinor.1"; $vNext2 = "$nMajor.$nMinor.2"; $vNext3 = "$nMajor.$nMinor.3"

[void](Invoke-Native (Get-GitExe) @('init', '-q', '--bare', '-b', 'main', $origin) 60)
[void](Invoke-Native (Get-GitExe) @('clone', '-q', $origin, $src) 60)
[void](G $src @('checkout', '-q', '-b', 'main'))
$manifest = ConvertFrom-JsonText (Get-Text (Join-Path (Join-Path $repoRoot 'nt8') 'install-files.json'))
$files = @('nt8/install-files.json', 'live/COMPAT.json', 'nt8/update-pc.ps1') + @($manifest['addons']) + @($manifest['www'] | ForEach-Object { $_['from'] })
foreach ($f in ($files | Select-Object -Unique)) {
  $to = Get-LocalPath $src $f
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
  Copy-Item -LiteralPath (Get-LocalPath $repoRoot $f) -Destination $to
}
$c1 = Commit 'the page as on main' { }
[void](Invoke-Native (Get-GitExe) @('clone', '-q', $origin, $clone) 60)

$cbDir = Join-Path $nt 'ChartBridge'
Put (Join-Path $cbDir 'config.txt') "# this PC's own`r`nport = 8765`r`ntrading = true`r`n"
Put (Join-Path $cbDir 'pin.txt') "# pin`r`n# hash`r`nnot-a-real-hash`r`n"
Put (Join-Path (Join-Path $cbDir 'www') 'anthony-notes.txt') "a file of Anthony's in www`r`n"
Put (Join-Path (Join-Path (Join-Path (Join-Path $nt 'bin') 'Custom') 'AddOns') 'ChartBridge.cs') "// the ChartBridge compiled on this PC (older)`r`n"
Put (Join-Path (Join-Path (Join-Path (Join-Path $nt 'bin') 'Custom') 'AddOns') 'SomethingElse.cs') "// another add-on`r`n"
Initialize-Paths -Repo $clone -NtFolder $nt
$configHash = Get-Hash $script:P.Config
$pinHash = Get-Hash (Join-Path $cbDir 'pin.txt')
$notesHash = Get-Hash (Get-WwwFile 'anthony-notes.txt')
$addOnsBefore = Get-AddOnsPrint

Write-Host "pc-updater tests ($($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion), git $((G $src @('--version'))))"

# ---------------------------------------------------------------------------------------------- CI gate

Test 'CI: both required jobs green is success' {
  $green = @(@{ name = 'unit (ubuntu-latest)'; status = 'completed'; conclusion = 'success'; app = @{ slug = 'github-actions' } }, @{ name = 'unit (windows-latest)'; status = 'completed'; conclusion = 'success'; app = @{ slug = 'github-actions' } }, @{ name = 'deploy'; status = 'completed'; conclusion = 'success'; app = @{ slug = 'github-actions' } })
  Assert ((Resolve-CiState $green @()).state -eq 'success') 'success'
}
Test 'CI: windows-latest missing is not success (pending)' {
  $r = Resolve-CiState @(@{ name = 'unit (ubuntu-latest)'; status = 'completed'; conclusion = 'success'; app = @{ slug = 'github-actions' } }) @()
  Assert ($r.state -eq 'pending' -and $r.detail -match 'windows-latest') $r.detail
}
Test 'CI: a failed required job is failure' {
  $r = Resolve-CiState @(@{ name = 'unit (ubuntu-latest)'; status = 'completed'; conclusion = 'success'; app = @{ slug = 'github-actions' } }, @{ name = 'unit (windows-latest)'; status = 'completed'; conclusion = 'failure'; app = @{ slug = 'github-actions' } }) @()
  Assert ($r.state -eq 'failure') $r.detail
}
Test 'CI: any other failed check or status is failure; running is pending; nothing is pending' {
  $ok = @(@{ name = 'unit (ubuntu-latest)'; status = 'completed'; conclusion = 'success'; app = @{ slug = 'github-actions' } }, @{ name = 'unit (windows-latest)'; status = 'completed'; conclusion = 'success'; app = @{ slug = 'github-actions' } })
  Assert ((Resolve-CiState ($ok + @(@{ name = 'deploy'; status = 'completed'; conclusion = 'failure'; app = @{ slug = 'github-actions' } })) @()).state -eq 'failure') 'other check failed'
  Assert ((Resolve-CiState $ok @(@{ context = 'x'; state = 'error' })).state -eq 'failure') 'status error'
  Assert ((Resolve-CiState ($ok + @(@{ name = 'deploy'; status = 'in_progress'; conclusion = $null; app = @{ slug = 'github-actions' } })) @()).state -eq 'pending') 'running'
  Assert ((Resolve-CiState @() @()).state -eq 'pending') 'no results'
  Assert ((Resolve-CiState @(@{ name = 'unit (ubuntu-latest)'; status = 'completed'; conclusion = 'skipped'; app = @{ slug = 'github-actions' } }, @{ name = 'unit (windows-latest)'; status = 'completed'; conclusion = 'success'; app = @{ slug = 'github-actions' } }) @()).state -eq 'failure') 'a skipped required job is not success'
}
Test 'CI: GitHub not reachable is unknown; the repo is read from the origin URL' {
  $script:FakeCi = 'unknown'
  $r = Get-CiState 'owner/chart-engine' 'abc'
  Assert ($r.state -eq 'unknown') "unknown, got $($r.state) $($r.detail)"
  $script:FakeCi = 'success'
  Assert ((Get-CiState 'owner/chart-engine' 'abc').state -eq 'success') 'green through the stubbed API'
  Assert ((ConvertTo-RepoSlug 'https://github.com/anthonydirect17/chart-engine.git') -eq 'anthonydirect17/chart-engine') 'https'
  Assert ((ConvertTo-RepoSlug 'git@github.com:anthonydirect17/chart-engine') -eq 'anthonydirect17/chart-engine') 'ssh'
  Assert ($null -eq (ConvertTo-RepoSlug 'C:\somewhere\origin.git')) 'not GitHub'
}
Test 'CI through the real GitHub reader: junk is unknown, an empty answer pending, a failed request unknown' {
  $keep = ${function:Invoke-GitHubJson}
  ${function:Invoke-GitHubJson} = $script:RealGitHubJson
  try {
    $script:WebAnswer = 'not json'
    function Invoke-WebRequest { if ($script:WebAnswer -eq 'throw') { throw (New-Object System.Net.WebException 'stub: refused') }; return @{ Content = $script:WebAnswer } }
    Assert ((Get-CiState 'owner/chart-engine' 'abc').state -eq 'unknown') 'junk'
    $script:WebAnswer = '{}'
    Assert ((Get-CiState 'owner/chart-engine' 'abc').state -eq 'pending') 'no check_runs'
    $script:WebAnswer = 'throw'
    Assert ((Get-CiState 'owner/chart-engine' 'abc').state -eq 'unknown') 'refused'
    $script:WebAnswer = '{"check_runs":[{"name":"unit (ubuntu-latest)","status":"completed","conclusion":"success","app":{"slug":"github-actions"}},{"name":"unit (windows-latest)","status":"completed","conclusion":"success","app":{"slug":"other-app"}}]}'
    Assert ((Get-CiState 'owner/chart-engine' 'abc').state -eq 'pending') 'a required job from another app does not count'
  } finally { Remove-Item function:\Invoke-WebRequest -ErrorAction SilentlyContinue; ${function:Invoke-GitHubJson} = $keep }
}
Test 'git never asks anything, never runs gc in the clone, and only reading subcommands can run' {
  $keep = ${function:Invoke-Native}
  $script:Seen = @()
  function Invoke-Native([string]$Exe, [string[]]$ArgList, [int]$TimeoutSec) { $script:Seen = $ArgList; return @{ code = 0; out = ''; err = '' } }
  try { [void](Invoke-Git @('fetch', '--quiet', 'origin', 'main')) } finally { ${function:Invoke-Native} = $keep }
  foreach ($o in @('credential.interactive=never', 'core.sshCommand=ssh -o BatchMode=yes', 'core.askPass=', 'gc.auto=0', 'maintenance.auto=false')) {
    Assert ($script:Seen -contains $o) "git -c $o"
  }
  foreach ($bad in @('checkout', 'merge', 'pull', 'reset', 'config', 'gc', 'switch', 'stash', 'clean')) {
    $threw = $false
    try { [void](Invoke-Git @($bad, 'x')) } catch { $threw = $_.Exception.Message -match 'not allowed' }
    Assert $threw "git $bad refused"
  }
}
Test 'git: symbolic-ref, remote and hash-object only in their reading forms (the whole argument list is checked)' {
  $keep = ${function:Invoke-Native}
  function Invoke-Native([string]$Exe, [string[]]$ArgList, [int]$TimeoutSec) { return @{ code = 0; out = ''; err = '' } }
  try {
    foreach ($ok in @(@('symbolic-ref', '-q', '--short', 'HEAD'), @('remote', 'get-url', 'origin'), @('hash-object', '--path=nt8/update-pc.ps1', '--', 'f.ps1'), @('hash-object', '--', 'f'))) {
      Assert ($null -eq (Test-GitArgs $ok)) "allowed: git $($ok -join ' ')"
      [void](Invoke-Git $ok)
    }
    foreach ($bad in @(@('symbolic-ref', 'refs/heads/probe', 'refs/heads/main'), @('symbolic-ref', '-d', 'HEAD'), @('symbolic-ref', '--delete', 'HEAD'), @('symbolic-ref', '-m', 'x', 'HEAD', 'refs/heads/x'),
        @('remote', 'add', 'x', 'https://example.invalid/x'), @('remote', 'set-url', 'origin', 'x'), @('remote', 'remove', 'origin'), @('remote', 'get-url', '--push', 'origin'), @('remote', 'prune', 'origin'),
        @('hash-object', '-w', '--', 'f'), @('hash-object', '--path=x', '-w', '--', 'f'), @('hash-object', '--stdin'), @('hash-object', '-t', 'blob', '--', 'f'), @('hash-object', '--'))) {
      $threw = $false
      try { [void](Invoke-Git $bad) } catch { $threw = $_.Exception.Message -match 'allowed only' }
      Assert $threw "refused: git $($bad -join ' ')"
    }
  } finally { ${function:Invoke-Native} = $keep }
}
Test 'CI pending: no update, nothing written to www or AddOns' {
  $script:FakeCi = 'pending'; $script:FakeDiag = $null
  $r = Run-Update
  Assert ($r.outcome -eq 'ci_pending') $r.outcome
  Assert (-not (Test-Path (Get-WwwFile 'live.js'))) 'no page file'
  Assert (-not (Test-Path $script:P.Staged)) 'nothing staged before CI is green'
}
Test 'CI failure and unknown: no update (unknown is a STOP)' {
  $script:FakeCi = 'failure'
  Assert ((Run-Update).outcome -eq 'ci_failure') 'ci_failure'
  $script:FakeCi = 'unknown'
  $r = Run-Update
  Assert ($r.outcome -eq 'ci_unknown' -and $script:StopOutcomes -contains $r.outcome) $r.outcome
  Assert (-not (Test-Path (Get-WwwFile 'live.js'))) 'no page file'
}

# ---------------------------------------------------------------------------------------------- ChartBridge version gates

Test 'unknown ChartBridge version: the page is not installed, and the log says why' {
  $script:FakeCi = 'success'; $script:FakeDiag = $null
  $s = Read-State; $s['chartBridge'] = @{}; Save-State $s          # nothing ever seen or recorded on this PC
  $r = Run-Update
  Assert ($r.outcome -eq 'cb_unknown') $r.outcome
  Assert ($r.reason -match 'not known') $r.reason
  Assert (-not (Test-Path (Get-WwwFile 'live.js'))) 'no page file'
  Assert ((Get-Text $script:P.Log) -match 'cb_unknown') 'logged'
  $st = Read-JsonFile $script:P.Status
  Assert ($st['outcome'] -eq 'cb_unknown') 'status.json says so'
}
Test 'a /diag version that is not a version (fake-0.2.0) counts as unknown' {
  $script:FakeDiag = 'fake-0.2.0'
  Assert ((Run-Update).outcome -eq 'cb_unknown') 'cb_unknown'
  $script:FakeDiag = $null
  Assert ((Run-Update).outcome -eq 'cb_unknown') 'and what it said is no version to fall back on'
}
Test 'the last version /diag showed counts when ChartBridge is not running' {
  $script:FakeDiag = $vBelow
  [void](Get-CompiledChartBridge ($s = Read-State)); Save-State $s
  $script:FakeDiag = $null
  $c = Get-CompiledChartBridge (Read-State)
  Assert ($c.version -eq $vBelow -and $c.source -eq 'recorded') "$($c.version) $($c.source)"
}
Test 'compat gate: page needs a newer ChartBridge, so no update' {
  $script:FakeDiag = $vBelow
  $r = Run-Update
  Assert ($r.outcome -eq 'needs_chartbridge') $r.outcome
  Assert ($r.reason -match (Rx $vMin) -and $r.reason -match (Rx $vBelow)) $r.reason
  Assert (-not (Test-Path (Get-WwwFile 'live.js'))) 'no page file'
}

# ---------------------------------------------------------------------------------------------- 0.6.3: ended fetches (ops audit)

Test 'a stale origin/main ref lock (a fetch that was ended) is removed before the fetch; a young one is left and named' {
  $lock = Get-GitPath "refs/remotes/origin/main.lock"
  Assert ($lock -and [IO.Path]::IsPathRooted($lock)) "the lock's path in the clone: $lock"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $lock) | Out-Null
  Put $lock "left by an ended fetch`n"
  (Get-Item -LiteralPath $lock).LastWriteTime = (Get-Date).AddMinutes(-30)
  [void](Get-Said)
  $f = Invoke-Fetch
  Assert ($f.code -eq 0) "the fetch went: $($f.err)"
  Assert (-not (Test-Path -LiteralPath $lock)) 'the stale lock is gone'
  Assert ((Get-Said) -match 'removed a stale git lock \(refs/remotes/origin/main\.lock, 30 min old') 'the log says it was removed'
  Put $lock "another git working now`n"
  $f = Invoke-Fetch
  Assert (Test-Path -LiteralPath $lock) 'a young lock is left (another git may be working)'
  Assert ((Get-Said) -match 'a git lock is there \(refs/remotes/origin/main\.lock, 0 min old\): left') 'and named'
  Remove-Item -LiteralPath $lock -Force
  Put $lock "old`n"; (Get-Item -LiteralPath $lock).LastWriteTime = (Get-Date).AddMinutes(-30)
  [void](Invoke-Fetch -DryRun)
  Assert ((Test-Path -LiteralPath $lock) -and ((Get-Said) -match 'would be removed')) 'a dry run only says so'
  Remove-Item -LiteralPath $lock -Force
}

Test 'a program that times out is ended with the programs it started (taskkill /T on Windows, Kill(true) elsewhere)' {
  $body = ${function:Stop-ProcessTree}.ToString()
  Assert ($body -match "@\('/T', '/F', '/PID'" -and $body -match 'Kill\(\$true\)') 'taskkill /T /F on Windows, the whole tree elsewhere'
  Assert (${function:Invoke-Native}.ToString() -match 'Stop-ProcessTree \$p') 'Invoke-Native ends the tree on its time limit'
  if ($IsWin) { return }
  $pidFile = Join-Path $tmpRoot 'child.pid'
  $r = Invoke-Native '/bin/sh' @('-c', "sleep 60 & echo `$! > '$pidFile'; wait") 2
  Assert ($r.code -eq -1 -and $r.err -match 'timed out') "timed out: $($r.err)"
  $child = [int](Get-Text $pidFile).Trim()
  Start-Sleep -Milliseconds 300
  # gone, or a zombie (ended, waiting for a parent to reap it: no init reaps in some containers)
  $stat = "/proc/$child/stat"
  $state = if (Test-Path -LiteralPath $stat) { ((Get-Text $stat) -split '\) ')[1].Substring(0, 1) } else { 'gone' }
  Assert ($state -eq 'gone' -or $state -eq 'Z') "the child it started (pid $child) is ended too (state $state)"
}

# ---------------------------------------------------------------------------------------------- staging and the swap

$script:FirstBuild = $null
Test 'green, compatible: staged, then installed file by file; nothing else in www touched' {
  $script:FakeDiag = $vPc
  $r = Run-Update
  Assert ($r.outcome -eq 'updated') "$($r.outcome) $($r.reason)"
  foreach ($w in $manifest['www']) {
    Assert (Get-TextSame (Get-WwwFile $w['to']) (Get-LocalPath $src $w['from'])) "$($w['to']) matches the commit"
  }
  Assert (@(Get-ChildItem -Recurse -LiteralPath $script:P.Www -Filter '*.upd-tmp').Count -eq 0) 'no temporary file left'
  Assert ((Get-Hash (Get-WwwFile 'anthony-notes.txt')) -eq $notesHash) 'a file of Anthony''s in www untouched'
  $u = Get-UpdateJson
  Assert ($u['page']['build'] -eq $r.stage.build -and $u['page']['commit'] -eq $c1 -and $u['page']['installedAt'] -gt 0) 'update.json'
  Assert ($u['chartBridge']['compiled'] -eq $vPc) 'update.json compiled ChartBridge'
  $s = Read-State
  Assert ($s['page']['build'] -eq $r.stage.build) 'state.json page'
  Assert (Test-Path (Join-Path $script:P.Previous 'previous.json')) 'previous kept'
  $raw = Get-Text $script:P.State
  Assert ($raw -notmatch '"Count"' -and $raw -notmatch '"value"') 'state.json holds plain arrays (Windows PowerShell 5.1 can write {"value":..,"Count":..})'
  Assert (@($s['page']['files']).Count -eq @($manifest['www']).Count -and @($s['ciGreen']).Count -ge 1 -and $s['ciGreen'][0] -is [string]) 'arrays read back as arrays'
  $script:FirstBuild = $r.stage.build
}
Test 'a second run changes nothing (up to date, same installedAt); the command returns one number' {
  $before = (Get-UpdateJson)['page']['installedAt']
  Assert-Code (Invoke-Update) 0 'update OK'
  $r = @{ outcome = (Read-JsonFile $script:P.Status)['outcome'] }
  Assert ($r.outcome -eq 'up_to_date') $r.outcome
  Assert-Code (Invoke-Update -DryRun) 0 'check OK'
  Assert ((Get-UpdateJson)['page']['installedAt'] -eq $before) 'installedAt kept'
}
$script:C2 = $null
Test 'a new commit on main is installed; the previous page is kept; the clone is never moved' {
  $script:C2 = Commit 'page change' { Put (Get-LocalPath $src 'live/live.js') ((Get-Text (Get-LocalPath $src 'live/live.js')) + "`n/* a page change */`n") }
  $r = Run-Update
  Assert ($r.outcome -eq 'updated') $r.outcome
  Assert ((Get-Text (Get-WwwFile 'live.js')) -match 'a page change') 'new live.js'
  Assert ((Get-Text (Get-LocalPath (Join-Path $script:P.Previous 'page') 'live.js')) -notmatch 'a page change') 'old live.js kept'
  Assert ((Read-JsonFile (Join-Path $script:P.Previous 'previous.json'))['build'] -eq $script:FirstBuild) 'previous build'
  Assert ((G $clone @('rev-parse', 'HEAD')) -eq $c1) 'the clone stays where Anthony left it'
  Assert ((G $clone @('rev-parse', 'refs/remotes/origin/main')) -eq $script:C2) 'only origin/main moved (fetch)'
}
Test 'a commit that changes no page file keeps the build (no "Update ready" on open pages)' {
  $before = Get-UpdateJson
  $c = Commit 'docs only' { Put (Get-LocalPath $src 'nt8/NOTES.txt') "docs`n" }
  $r = Run-Update
  Assert ($r.outcome -eq 'up_to_date') $r.outcome
  $u = Get-UpdateJson
  Assert ($u['page']['build'] -eq $before['page']['build'] -and $u['page']['installedAt'] -eq $before['page']['installedAt']) 'same build, same installedAt'
  Assert ($u['page']['commit'] -eq $c) 'commit recorded'
}
if ($IsWin) {
  Test 'a replace waits for a reader that holds the file (as ChartBridge''s ReadAllBytes does)' {
    $target = Join-Path $tmpRoot 'held.txt'; Put $target 'old'
    $tmp = Join-Path $tmpRoot 'held.txt.upd-tmp'; Put $tmp 'new'
    $fs = [IO.File]::Open($target, 'Open', 'Read', 'Read')
    $job = [PowerShell]::Create().AddScript({ param($f) Start-Sleep -Milliseconds 400; $f.Dispose() }).AddArgument($fs)
    $h = $job.BeginInvoke()
    Move-FileAtomic $tmp $target
    $job.EndInvoke($h); $job.Dispose()
    Assert ((Get-Text $target) -eq 'new') 'replaced after the reader let go'
  }
} else { Skip 'a replace waits for a reader that holds the file' 'Windows file sharing' }

# ---------------------------------------------------------------------------------------------- rollback

Test 'rollback puts the previous page back and skips that commit until a newer one' {
  Assert-Code (Invoke-Rollback) 0 'rollback OK'
  Assert ((Get-Text (Get-WwwFile 'live.js')) -notmatch 'a page change') 'old live.js back'
  $s = Read-State
  Assert ($s['page']['build'] -eq $script:FirstBuild) 'state build is the old one'
  Assert ($s['skipCommit'] -ne $null) 'a commit is skipped'
  $r = Run-Update
  Assert ($r.outcome -eq 'held') "held, got $($r.outcome)"
  Assert ((Get-Text (Get-WwwFile 'live.js')) -notmatch 'a page change') 'still the old live.js'
  Assert ((Get-UpdateJson)['page']['build'] -eq $script:FirstBuild) 'update.json says the old build'
}
Test 'a newer commit after a rollback installs again' {
  [void](Commit 'another page change' { Put (Get-LocalPath $src 'live/live.css') ((Get-Text (Get-LocalPath $src 'live/live.css')) + "`n/* css change */`n") })
  $r = Run-Update
  Assert ($r.outcome -eq 'updated') $r.outcome
  Assert ((Get-Text (Get-WwwFile 'live.css')) -match 'css change') 'new css'
}

# ---------------------------------------------------------------------------------------------- pause

Test 'pause: the automatic path does nothing; resume: it updates again' {
  Assert-Code (Invoke-Pause) 0 'pause OK'
  [void](Commit 'while paused' { Put (Get-LocalPath $src 'live/pin.css') ((Get-Text (Get-LocalPath $src 'live/pin.css')) + "`n/* paused change */`n") })
  $r = Run-Update
  Assert ($r.outcome -eq 'paused') $r.outcome
  Assert ((Get-Text (Get-WwwFile 'pin.css')) -notmatch 'paused change') 'nothing installed while paused'
  Assert ((Read-JsonFile $script:P.Status)['paused'] -eq $true) 'status.json paused'
  Assert-Code (Invoke-Resume) 0 'resume OK'
  Assert ((Run-Update).outcome -eq 'updated') 'updated after resume'
  Assert ((Get-Text (Get-WwwFile 'pin.css')) -match 'paused change') 'installed after resume'
}

# ---------------------------------------------------------------------------------------------- ChartBridge is never installed automatically

$script:CbCommit = $null
Test 'a new ChartBridge is staged and announced, and the automatic path writes no .cs file into AddOns' {
  $script:CbCommit = Commit "ChartBridge $vNeeds and a page that needs it" { Set-CbVersion $vNeeds; Set-MinCb $vNeeds; Put (Get-LocalPath $src 'live/live.js') ((Get-Text (Get-LocalPath $src 'live/live.js')) + "`n/* needs $vNeeds */`n") }
  $script:Toasts = @()
  $r = Run-Update
  Assert ($r.outcome -eq 'needs_chartbridge') $r.outcome
  Assert ((Read-JsonFile (Join-Path $script:P.Staged 'stage.json'))['chartBridgeVersion'] -eq $vNeeds) "staged $vNeeds"
  Assert (Test-Path (Join-Path (Join-Path $script:P.Staged 'addons') 'ChartBridge.cs')) 'add-on staged under updater\staged'
  Assert ((Get-UpdateJson)['chartBridge']['ready'] -eq $vNeeds) 'update.json: ready'
  Assert ((Read-JsonFile $script:P.Status)['chartBridge']['ready'] -eq $vNeeds) 'status.json: ready'
  Assert ($script:Toasts.Count -eq 1 -and $script:Toasts[0] -match (Rx $vNeeds)) 'one notification'
  Assert ((Get-Text (Get-WwwFile 'live.js')) -notmatch "needs $(Rx $vNeeds)") "page that needs $vNeeds not installed"
  [void](Run-Update)
  Assert ($script:Toasts.Count -eq 1) 'not announced twice'
  Assert ((Get-AddOnsPrint) -eq $addOnsBefore) 'AddOns unchanged by every automatic run'
}
Test 'the add-on copy refuses without -InstallChartBridge' {
  $threw = $false
  try { [void](Install-AddOnFiles (Read-JsonFile (Join-Path $script:P.Staged 'stage.json'))) } catch { $threw = $_.Exception.Message -match 'refused' }
  Assert $threw 'refused'
  Assert ((Get-AddOnsPrint) -eq $addOnsBefore) 'AddOns unchanged'
}
Test 'register pins the staged copy of the newest green main, checked against its git blob' {
  $dest = Invoke-PinForTask '17:05'
  $stage = Read-JsonFile (Join-Path $script:P.Staged 'stage.json')
  $pin = Read-JsonFile (Join-Path $script:P.Bin 'pinned.json')
  Assert ($pin['from'] -eq 'register' -and $pin['commit'] -eq $stage['commit'] -and $pin['blob'] -eq $stage['updaterBlob']) 'pinned.json: the staged commit and its blob'
  Assert ((Get-BlobId $dest 'nt8/update-pc.ps1') -eq $pin['blob'] -and (Get-Hash $dest) -eq $pin['sha256'].ToUpperInvariant()) 'the file is that blob'
  Assert ($pin['repo'] -eq $clone -and $pin['dailyAt'] -eq '17:05') 'the clone and the daily time'
}
Test 'register refuses an edited or branch updater when main cannot be staged; the same file as a green commit is fine' {
  $keepSelf = $script:UpdaterSelf
  $script:FakeCi = 'pending'
  [void](Commit 'CI running' { Put (Get-LocalPath $src 'nt8/NOTES.txt') "docs 9`n" })
  Remove-Dir $script:P.Staged
  try {
    $dest = Invoke-PinForTask '17:05'
    Assert ((Read-JsonFile (Join-Path $script:P.Bin 'pinned.json'))['from'] -eq 'register') 'this file is the same as in a green commit: pinned'
    $edited = Join-Path $tmpRoot 'edited-update-pc.ps1'
    Put $edited ((Get-Text $keepSelf) + "`n# a local edit`n")
    $script:UpdaterSelf = $edited
    $threw = $false
    try { [void](Invoke-PinForTask '17:05') } catch { $threw = $_.Exception.Message -match 'not the file of a commit seen green' }
    Assert $threw 'an edited file is refused'
    Assert ((Get-Hash $dest) -ne (Get-Hash $edited)) 'the pinned copy did not change'
  } finally { $script:UpdaterSelf = $keepSelf; $script:FakeCi = 'success' }
  [void](Run-Update)
}
Test 'the pinned copy checks itself at every run: a changed file does nothing' {
  $keepSelf = $script:UpdaterSelf
  $bin = Join-Path $script:P.Bin 'update-pc.ps1'
  $script:UpdaterSelf = $bin
  try {
    Assert ($null -eq (Test-PinnedSelf)) 'as pinned'
    $orig = Get-Text $bin
    Put $bin ($orig + "`n# changed`n")
    Assert ((Test-PinnedSelf) -match 'changed since it was pinned') 'changed: STOP'
    Put $bin $orig
  } finally { $script:UpdaterSelf = $keepSelf }
  [void](Invoke-PinForTask '17:05')
}
Test 'the pinned copy without its pinned.json: STOP, and status.json and the page say so (review 3 N-a, N-a2)' {
  $keepSelf = $script:UpdaterSelf
  $bin = Join-Path $script:P.Bin 'update-pc.ps1'
  $pj = Join-Path $script:P.Bin 'pinned.json'
  $saved = Get-Text $pj
  $script:UpdaterSelf = $bin
  try {
    Remove-Item -LiteralPath $pj -Force
    $bad = Test-PinnedSelf
    Assert ($bad -match 'no pinned\.json' -and $bad -match 'nothing done') "missing pinned.json is a STOP: $bad"
    $script:UpdaterSelf = $keepSelf
    Assert ($null -eq (Test-PinnedSelf)) 'the clone''s copy is not the pinned one: it runs'
    Write-StopRecord $bad
    $st = Read-JsonFile $script:P.Status
    Assert ($st['outcome'] -eq 'updater_stopped' -and $st['updater']['stopped'] -eq $true -and $st['reason'] -match 'no pinned\.json') 'status.json says the updater stopped'
    $u = Get-UpdateJson
    Assert ($u['updater']['stopped'] -eq $true -and $u['page']['build']) 'update.json: "Updater stopped" for the page, the page part kept'
    Assert ((Get-Text (Join-Path $script:P.Www 'update.json')) -notmatch 'pinned|updater\\bin') 'no path in the served file'
    $script:UpdaterStopped = $false                             # a later run, another process
    [void](Run-Update)
    Assert ((Get-UpdateJson)['updater']['stopped'] -eq $true -and (Read-JsonFile $script:P.Status)['updater']['stopped'] -eq $true) 'a run of the clone''s copy still says the task is stopped'
  } finally { $script:UpdaterSelf = $keepSelf; $script:UpdaterStopped = $false; Put $pj $saved }
  [void](Run-Update)
  Assert ($null -eq (Get-UpdateJson)['updater'] -and $null -eq (Read-JsonFile $script:P.Status)['updater']) 'pinned again: the notice goes'
}
Test 'the task''s own copy of the updater is changed only by register or -InstallChartBridge' {
  $dest = Join-Path $script:P.Bin 'update-pc.ps1'
  Assert ((Read-JsonFile (Join-Path $script:P.Bin 'pinned.json'))['from'] -eq 'register') 'pinned.json'
  $before = Get-Hash $dest
  [void](Run-Update); [void](Run-Update)
  Assert ((Get-Hash $dest) -eq $before) 'automatic runs leave it alone'
  $args = Get-TaskArguments $dest $clone
  Assert ($args -match [regex]::Escape($dest) -and $args -match ' update -Repo ') $args
}
Test '-InstallChartBridge (Anthony, flat) copies the staged add-on files; the page that needs them waits for F5' {
  Put (Join-Path $script:P.AddOns 'ChartBridge.cs') "// the ChartBridge compiled on this PC (older)`r`npublic const string Version = ""$vPc"";`r`n"
  $addOnsBefore2 = Get-AddOnsPrint
  $script:Yes = $true
  $code = Invoke-InstallChartBridge
  $script:Yes = $false
  Assert-Code $code 0 'OK'
  foreach ($n in @('ChartBridge.cs', 'ChartBridgeOrders.cs', 'ChartBridgePin.cs')) {
    Assert (Get-TextSame (Join-Path $script:P.AddOns $n) (Get-LocalPath $src "nt8/$n")) "$n copied"
  }
  Assert ((Get-Text (Join-Path $script:P.AddOns 'SomethingElse.cs')) -match 'another add-on') 'other add-ons untouched'
  $bk = @(Get-ChildItem -Recurse -LiteralPath $script:P.PrevAddOns -Filter 'ChartBridge.cs')
  Assert ($bk.Count -eq 1 -and (Get-Text $bk[0].FullName) -match 'older') 'the replaced ChartBridge.cs kept'
  Assert ($addOnsBefore2 -ne (Get-AddOnsPrint)) 'AddOns changed (by hand, with y)'
  Assert (@(Get-ChildItem -LiteralPath $script:P.AddOns -Filter '*.upd-tmp').Count -eq 0) 'no temporary file left in AddOns'
  Assert ((Get-Text (Get-WwwFile 'live.js')) -notmatch "needs $(Rx $vNeeds)") "the page that needs $vNeeds is not installed before F5"
  Assert ((Read-State)['pendingPage']['needs'] -eq $vNeeds) 'the page waits for F5'
  Assert ((Get-UpdateJson)['chartBridge']['copied'] -eq $vNeeds -and -not (Get-UpdateJson)['chartBridge']['ready']) 'update.json: copied, waiting for F5'
  $pin = Read-JsonFile (Join-Path $script:P.Bin 'pinned.json')
  Assert ($pin['commit'] -eq (Read-JsonFile (Join-Path $script:P.Staged 'stage.json'))['commit']) 'the task''s updater is the staged commit''s'
  Assert ((Get-Hash (Join-Path $script:P.Bin 'update-pc.ps1')) -eq (Get-Hash (Join-Path (Join-Path $script:P.Staged 'bin') 'update-pc.ps1'))) 'the staged updater'
  Assert ((Get-Hash $script:P.Config) -eq $configHash -and (Get-Hash (Join-Path $cbDir 'pin.txt')) -eq $pinHash) 'config.txt and pin.txt untouched'
}
Test 'before F5 (ChartBridge not running): the lower of last seen and copied counts' {
  $script:FakeDiag = $null
  $c = Get-CompiledChartBridge (Read-State)
  Assert ($c.version -eq $vPc -and $c.source -eq 'recorded') "$($c.version) $($c.source)"
}
Test 'after F5 /diag shows the new version: confirmed, the waiting page installs; without /diag the recorded version counts' {
  $script:FakeDiag = $vNeeds
  $r = Run-Update
  Assert ($r.outcome -eq 'updated') $r.outcome
  Assert ((Get-Text (Get-WwwFile 'live.js')) -match "needs $(Rx $vNeeds)") "the page that needs $vNeeds installed after F5"
  Assert (-not (Read-State).Contains('pendingPage')) 'nothing waits any more'
  $s = Read-State
  Assert ($s['chartBridge']['installed']['confirmed'] -eq $true) 'confirmed'
  Assert (-not (Get-UpdateJson)['chartBridge']['copied']) 'no longer waiting for F5'
  $script:FakeDiag = $null
  $c = Get-CompiledChartBridge (Read-State)
  Assert ($c.version -eq $vNeeds -and $c.source -eq 'recorded') "$($c.version) $($c.source)"
}
Test 'Anthony goes back to the older ChartBridge by hand: the newest /diag counts, and with NinjaTrader closed the lower one (the reviewer''s p2)' {
  $script:FakeDiag = $vPc
  $s = Read-State; [void](Get-CompiledChartBridge $s); Save-State $s
  Assert ((Get-Text $script:P.Log) -match "went down from $(Rx $vNeeds) to $(Rx $vPc)") 'a downgrade is logged'
  $script:FakeDiag = $null
  $c = Get-CompiledChartBridge (Read-State)
  Assert ($c.version -eq $vPc) "counts $vPc, got $($c.version) ($($c.detail))"
  # a hand copy this tool never saw: AddOns\ChartBridge.cs says the minimum (lower still), so no more than that counts
  $s = Read-State; $s['chartBridge']['diagVersion'] = $vNeeds; Save-State $s
  $keep = Get-Text (Join-Path $script:P.AddOns 'ChartBridge.cs')
  Put (Join-Path $script:P.AddOns 'ChartBridge.cs') ($keep -replace 'public const string Version = "[^"]+"', "public const string Version = ""$vMin""")
  $c = Get-CompiledChartBridge (Read-State)
  Assert ($c.version -eq $vMin) "the lower of recorded and AddOns: $($c.version)"
  Put (Join-Path $script:P.AddOns 'ChartBridge.cs') $keep
  $script:FakeDiag = $vNeeds
  $s = Read-State; [void](Get-CompiledChartBridge $s); Save-State $s
}

# ---------------------------------------------------------------------------------------------- a page install cut off

function Get-Marks {
  $a = if ((Get-Text (Get-WwwFile 'live.js')) -match 'MARK-(\d+)') { $Matches[1] } else { '0' }
  $b = if ((Get-Text (Get-WwwFile 'src/chart-engine.js')) -match 'MARK-(\d+)') { $Matches[1] } else { '0' }
  return "$a/$b"
}
function New-MarkCommit([int]$K) {
  return (Commit "live.js and chart-engine.js change together ($K)" {
    foreach ($f in @('live/live.js', 'src/chart-engine.js')) {
      $t = (Get-Text (Get-LocalPath $src $f)) -replace '/\* MARK-\d+ \*/', ''
      Put (Get-LocalPath $src $f) ($t + "/* MARK-$K */")
    }
  })
}
function Invoke-Cut([string]$At) {
  $script:CrashAt = $At; $script:PowerLost = $false
  $state = Read-State
  $out = 'no crash'
  try { $r = Invoke-Pass -State $state; $out = $r.outcome } catch { $out = $_.Exception.Message }
  $script:CrashAt = ''; $script:PowerLost = $false
  return $out
}
function Assert-Whole([string]$Why, [switch]$NoPrevious) {
  $s = Read-State
  Assert (-not (Test-Path $script:P.Journal)) "$Why : the journal is gone"
  Assert ((Get-BuildId $script:P.Www @($s['page']['files'])) -eq $s['page']['build']) "$Why : www is exactly the recorded build"
  $m = (Get-Marks).Split('/')
  Assert ($m[0] -eq $m[1]) "$Why : live.js and chart-engine.js from the same commit ($(Get-Marks))"
  Assert ((Get-UpdateJson)['page']['build'] -eq $s['page']['build'] -and -not (Get-UpdateJson)['page']['state']) "$Why : update.json says that build"
  if ($NoPrevious) { return }
  $pv = Read-JsonFile (Join-Path $script:P.Previous 'previous.json')
  $pm = (Get-Text (Get-LocalPath (Join-Path $script:P.Previous 'page') 'live.js')) -match 'MARK-(\d+)'
  $pa = if ($pm) { $Matches[1] } else { '0' }
  $pm2 = (Get-Text (Get-LocalPath (Join-Path $script:P.Previous 'page') 'src/chart-engine.js')) -match 'MARK-(\d+)'
  $pb = if ($pm2) { $Matches[1] } else { '0' }
  Assert ($pa -eq $pb -and (Get-BuildId (Join-Path $script:P.Previous 'page') @($pv['files'])) -eq $pv['build']) "$Why : the rollback copy is whole ($pa/$pb)"
}

Test 'the reviewer''s p1: cut off after one file, then CI pending for a newer commit: finished first, the rollback copy stays whole' {
  $script:FakeCi = 'success'; $script:FakeDiag = $vNeeds
  [void](Run-Update)
  $base = Get-Marks
  [void](New-MarkCommit 100)
  $out = Invoke-Cut 'file:1'
  Assert ($out -match 'SIMULATED POWER LOSS|install_failed') "cut off: $out"
  Assert (Test-Path $script:P.Journal) 'the journal says a swap was running'
  [void](Commit 'docs only, CI running' { Put (Get-LocalPath $src 'nt8/NOTES.txt') "docs 2`n" })
  $script:FakeCi = 'pending'
  $r = Run-Update
  Assert ($r.outcome -eq 'ci_pending' -and $r.recovered -eq 'finished') "$($r.outcome) / $($r.recovered)"
  Assert-Whole 'after the recovery'
  Assert ((Get-Marks) -eq '100/100') "the new page: $(Get-Marks)"
  Assert-Code (Invoke-Rollback) 0 'rollback'
  Assert ((Get-Marks) -eq $base) "rollback goes to the whole old page ($base), got $(Get-Marks)"
  Assert-Whole 'after the rollback'
  $script:FakeCi = 'success'
}

$points = @('after-previous', 'after-journal') + @(1..9 | ForEach-Object { "file:$_" }) + @('after-files', 'after-state')
$k = 200
foreach ($pt in $points) {
  $k++
  Test "a power loss at $pt; the next run (paused) finishes or undoes it first; never a mixed page" {
    $script:FakeCi = 'success'; $script:FakeDiag = $vNeeds
    [void](Invoke-Resume); [void](Run-Update)
    $old = Get-Marks
    [void](New-MarkCommit $k)
    $out = Invoke-Cut $pt
    Assert ($out -ne 'updated') "cut off at $pt ($out)"
    [void](Invoke-Pause)
    $r = Run-Update
    Assert ($r.outcome -eq 'paused') $r.outcome
    Assert-Whole "cut at $pt"
    if ($pt -eq 'after-previous') { Assert ((Get-Marks) -eq $old) "nothing had changed: $(Get-Marks)" }
    else { Assert ((Get-Marks) -eq "$k/$k" -and $r.recovered -eq 'finished') "finished: $(Get-Marks) ($($r.recovered))" }
    [void](Invoke-Resume)
    Assert ((Run-Update).outcome -match 'updated|up_to_date') 'then updates as usual'
    Assert ((Get-Marks) -eq "$k/$k") 'on the new page'
  }
}
Test 'cut off with neither the new nor the old files whole: STOP, and the page is told' {
  [void](New-MarkCommit 300)
  $out = Invoke-Cut 'file:1'
  $j = Read-JsonFile $script:P.Journal
  Put (Get-LocalPath $j['target']['source'] 'live.js') 'spoiled'
  Put (Get-LocalPath $j['back']['source'] 'live.js') 'spoiled'
  $r = Run-Update
  Assert ($r.outcome -eq 'interrupted' -and $script:StopOutcomes -contains 'interrupted') $r.outcome
  Assert ((Get-UpdateJson)['page']['state'] -eq 'interrupted') 'update.json: interrupted'
  Assert-Code (Invoke-Rollback) 1 'rollback refuses too'
  Assert ($r.reason -match 'update-pc\.ps1 repair' -and $r.reason -notmatch 'install\.ps1') "the STOP points at repair: $($r.reason)"
  # Anthony's way out: update-pc.ps1 repair (page files only). Staged and previous are spoiled: the clone's page files
  $addOnsNow = Get-AddOnsPrint
  Assert-Code (Invoke-Repair) 0 'repair'
  Assert-Whole 'after the repair (from the clone)' -NoPrevious   # previous\ was spoiled on purpose; repair never writes it
  Assert ((Get-AddOnsPrint) -eq $addOnsNow) 'repair never touches AddOns'
  Assert-Code (Invoke-Repair) 0 'nothing more to repair'
  Remove-Dir $script:P.Staged
  Assert ((Run-Update).outcome -eq 'updated') 'installs again'
  Assert ((Get-Marks) -eq '300/300') 'whole'
}
Test 'repair after a cut-off install finishes it from staged (page files only)' {
  [void](New-MarkCommit 310)
  $out = Invoke-Cut 'file:3'
  $addOnsNow = Get-AddOnsPrint
  Assert-Code (Invoke-Repair) 0 'repair'
  Assert-Whole 'after the repair'
  Assert ((Get-Marks) -eq '310/310' -and (Get-AddOnsPrint) -eq $addOnsNow) "finished: $(Get-Marks)"
}
Test 'the finish after a cut-off drops files the new build no longer has' {
  [void](Commit 'the page no longer has pin.css' {
    $m = Get-Text (Get-LocalPath $src 'nt8/install-files.json')
    Put (Get-LocalPath $src 'nt8/install-files.json') ($m -replace '\s*\{ "from": "live/pin.css", "to": "pin.css" \},', '')
    Put (Get-LocalPath $src 'live/live.js') ((Get-Text (Get-LocalPath $src 'live/live.js')) + "`n/* no pin.css */`n") })
  Assert (Test-Path (Get-WwwFile 'pin.css')) 'pin.css there before'
  $out = Invoke-Cut 'file:8'
  $r = Run-Update
  Assert ($r.recovered -eq 'finished') "$($r.outcome) / $($r.recovered)"
  Assert (-not (Test-Path (Get-WwwFile 'pin.css'))) 'pin.css dropped'
  Assert (Test-Path (Get-WwwFile 'anthony-notes.txt')) 'not a file this tool manages'
  [void](Commit 'pin.css back' { Put (Get-LocalPath $src 'nt8/install-files.json') (Get-Text (Get-LocalPath $repoRoot 'nt8/install-files.json')) })
  Assert ((Run-Update).outcome -eq 'updated') 'back'
}
Test '-InstallChartBridge after the .cs copy: a page that cannot be written now is not a STOP (the reviewer''s p4_icb)' {
  $cb = Commit "ChartBridge $vNext0; the page works with $vNeeds" { Set-CbVersion $vNext0; Put (Get-LocalPath $src 'live/live.js') ((Get-Text (Get-LocalPath $src 'live/live.js')) + "`n/* p4 */`n") }
  $script:FakeDiag = $null                                    # NinjaTrader closed (the last /diag said $vNeeds)
  $script:HoldLiveJs = $true; $script:Yes = $true
  try { $code = Invoke-InstallChartBridge } finally { $script:HoldLiveJs = $false; $script:Yes = $false }
  Assert-Code $code 0 'OK: ChartBridge copied, press F5; the page follows'
  $s = Read-State
  Assert ($s['chartBridge']['installed']['version'] -eq $vNext0 -and -not $s['chartBridge']['installed']['confirmed']) 'recorded at once'
  Assert ((Get-Text (Join-Path $script:P.AddOns 'ChartBridge.cs')) -match "Version = ""$(Rx $vNext0)""") 'the .cs files are in'
  Assert ($s['pendingPage']['commit'] -eq $cb -and (Get-Text $script:P.Log) -match 'the page could not be written now') 'the page follows (it was tried and failed)'
  Assert ((Get-UpdateJson)['chartBridge']['copied'] -eq $vNext0) 'the page says: copied, press F5'
  Assert ((Read-JsonFile (Join-Path $script:P.Bin 'pinned.json'))['commit'] -eq $cb) 'the task''s updater followed'
  $script:FakeDiag = $vNext0
  $r = Run-Update
  Assert ($r.outcome -match 'updated|up_to_date') "$($r.outcome) $($r.recovered)"
  Assert ((Get-Text (Get-WwwFile 'live.js')) -match '/\* p4 \*/' -and -not (Test-Path $script:P.Journal)) 'the page followed after F5'
  Assert (-not (Read-State).Contains('pendingPage')) 'nothing waits'
}
Test '-InstallChartBridge never pins an older updater than the pinned one' {
  $stage = Read-JsonFile (Join-Path $script:P.Staged 'stage.json')
  $newer = Commit 'a newer main, not staged here' { Put (Get-LocalPath $src 'nt8/NOTES.txt') "docs 10`n" }
  [void](Invoke-Git @('fetch', '--quiet', 'origin', 'main'))
  $pj = Join-Path $script:P.Bin 'pinned.json'
  $pin = Read-JsonFile $pj; $keep = $pin['commit']; $pin['commit'] = $newer; Write-JsonAtomic $pj $pin
  $note = Update-PinnedFromStage $stage
  Assert ($note -match 'stays at' -and (Read-JsonFile $pj)['commit'] -eq $newer) "refused: $note"
  $pin['commit'] = $keep; Write-JsonAtomic $pj $pin
}
$script:AddOnNames = @('ChartBridge.cs', 'ChartBridgeOrders.cs', 'ChartBridgePin.cs')
function Get-AddOnMarks { return (($script:AddOnNames | ForEach-Object { if ((Get-Text (Join-Path $script:P.AddOns $_)) -match "Version = ""$(Rx $vNext1)""|// test commit: ChartBridge $(Rx $vNext1)") { 'new' } else { 'old' } }) -join '/') }
Test 'Get-AddOnHashes: a file another program holds reads as unreadable, never a crash that hides a mix (review 4 SF1)' {
  if (-not (Test-Path $script:P.AddOns)) { New-Item -ItemType Directory -Force -Path $script:P.AddOns | Out-Null }
  Put (Join-Path $script:P.AddOns 'HeldProbe.cs') 'probe'
  $real = ${function:Get-FileSha256}
  Set-Item function:script:Get-FileSha256 { param([string]$Path) if ($Path -like '*HeldProbe.cs') { throw 'The process cannot access the file because it is being used by another process.' } }
  try { $h = Get-AddOnHashes @('HeldProbe.cs', 'NotThere.cs') } finally { Set-Item function:script:Get-FileSha256 $real; Remove-Item -LiteralPath (Join-Path $script:P.AddOns 'HeldProbe.cs') -Force }
  Assert ($h['HeldProbe.cs'] -eq 'unreadable') "a held file is 'unreadable' (got $($h['HeldProbe.cs']))"
  Assert ($h['NotThere.cs'] -eq 'missing') 'a missing file is still missing'
  Assert (-not (Test-SameHashes $h @{ 'HeldProbe.cs' = 'unreadable'; 'NotThere.cs' = 'x' })) 'an unreadable set never matches another set'
}

Test '-InstallChartBridge: an add-on file held past the retry puts back every file already replaced; AddOns exactly as before (the reviewer''s p5_addons)' {
  $script:FakeDiag = $vNext0
  [void](Commit "ChartBridge $vNext1 (three of the four add-on files change)" { Set-CbVersion $vNext1; foreach ($n in @('ChartBridgeOrders.cs', 'ChartBridgePin.cs')) { $f = Get-LocalPath $src "nt8/$n"; Put $f ((Get-Text $f) + "`n// test commit: ChartBridge $vNext1`n") } })
  [void](Run-Update)
  Assert ((Read-JsonFile (Join-Path $script:P.Staged 'stage.json'))['chartBridgeVersion'] -eq $vNext1) "staged $vNext1"
  $before = Get-AddOnsPrint
  # the record's fields, in a fixed order: a hashtable read back from JSON lists its keys in an order that depends on
  # insertion order when their hashes collide (always the same on Windows PowerShell 5.1), so JSON text is not compared
  $fields = { param($h) (@('version', 'commit', 'at', 'confirmed') | ForEach-Object { "$_=$(Get-Field $h $_)" }) -join ';' }
  $instBefore = & $fields (Read-State)['chartBridge']['installed']
  [void](Get-Said)
  $script:HoldAddOn = 'ChartBridgeOrders.cs'; $script:Yes = $true
  try { $code = Invoke-InstallChartBridge } finally { $script:HoldAddOn = ''; $script:Yes = $false }
  $said = Get-Said
  Assert-Code $code 1 'STOP'
  Assert ($said -match "STOP: ChartBridge $(Rx $vNext1) was not copied and nothing changed in AddOns" -and $said -match 'NinjaScript Editor holds it' -and $said -match 'Close the NinjaScript Editor') "says nothing changed, and why: $said"
  Assert ((Get-Text $script:P.Log) -match 'the add-on copy failed after 1 of \d+ files .*putting back: ChartBridge\.cs') 'ChartBridge.cs had been replaced (the reviewer''s mix), and was put back'
  Assert ((Get-AddOnsPrint) -eq $before) "AddOns exactly as before (every file's hash): $(Get-AddOnMarks)"
  Assert (@(Get-ChildItem -LiteralPath $script:P.AddOns | Where-Object { $_.Name -like '*.upd-*' }).Count -eq 0) 'no temporary file left in AddOns'
  $s = Read-State
  $instNow = & $fields $s['chartBridge']['installed']
  Assert ($instNow -eq $instBefore) "no copy recorded: installed was $instBefore, is $instNow"
  Assert (-not $s['chartBridge'].Contains('mixed')) 'no mix recorded'
  Assert (-not $s['chartBridge'].Contains('copying')) 'no copy left open'
  $u = Get-UpdateJson
  Assert (-not $u['chartBridge']['copied'] -and -not $u['chartBridge']['mixed'] -and $u['chartBridge']['ready'] -eq $vNext1) "the page still says: $vNext1 ready"
  Assert ((Read-JsonFile $script:P.Status)['outcome'] -eq 'chartbridge_not_copied') 'status.json'
}
Test '-InstallChartBridge: the put-back fails too: DO NOT press F5 on the console, in update.log, status.json and on the page, until AddOns is whole again' {
  $before = Get-AddOnsPrint
  [void](Get-Said)
  $script:HoldAddOn = 'ChartBridgeOrders.cs'; $script:HoldRestore = $true; $script:Yes = $true
  try { $code = Invoke-InstallChartBridge } finally { $script:HoldAddOn = ''; $script:HoldRestore = $false; $script:Yes = $false }
  $said = Get-Said
  Assert-Code $code 1 'STOP'
  Assert ($said -match '!!  DO NOT press F5: ChartBridge files are mixed\. Run update-pc\.ps1 status and report' -and $said -match 'STOP: DO NOT press F5: ChartBridge files are mixed\. Run update-pc\.ps1 status and report') "the console: $said"
  Assert ((Get-AddOnMarks) -eq 'new/old/old') "the mix the reviewer found: $(Get-AddOnMarks)"
  $mx = (Read-State)['chartBridge']['mixed']
  Assert ($mx -and (@($mx['changed']) -join ',') -eq 'ChartBridge.cs' -and $mx['version'] -eq $vNext1 -and (Test-Path (Join-Path $mx['backup'] 'ChartBridge.cs'))) 'recorded: what changed, and where the old files are'
  Assert ((Get-Text $script:P.Log) -match 'ERROR STOP: DO NOT press F5: ChartBridge files are mixed\. Run update-pc\.ps1 status and report') 'update.log'
  $st = Read-JsonFile $script:P.Status
  Assert ($st['outcome'] -eq 'chartbridge_mixed' -and $st['alert'] -eq 'DO NOT press F5: ChartBridge files are mixed. Run update-pc.ps1 status and report' -and $st['chartBridge']['mixed'] -eq $true) 'status.json'
  $u = Get-UpdateJson
  Assert ($u['chartBridge']['mixed'] -eq $true -and -not $u['chartBridge']['copied'] -and -not $u['chartBridge']['ready']) 'update.json: mixed, and nothing about F5 or ready'
  [void](Run-Update)
  Assert ((Get-UpdateJson)['chartBridge']['mixed'] -eq $true -and (Read-JsonFile $script:P.Status)['alert']) 'every later run keeps saying it'
  [void](Get-Said)
  Assert-Code (Invoke-Status) 1 'status is a STOP'
  $said = Get-Said
  Assert ($said -match 'STOP: DO NOT press F5: ChartBridge files are mixed' -and $said -match [regex]::Escape($mx['backup'])) "status says it, and where the old files are: $said"
  # Anthony puts the old files back from the backup by hand: whole again, and the notice goes
  foreach ($n in $script:AddOnNames) { Copy-Item -LiteralPath (Join-Path $mx['backup'] $n) -Destination (Join-Path $script:P.AddOns $n) -Force }
  Assert ((Get-AddOnsPrint) -eq $before) 'as before'
  [void](Run-Update)
  Assert (-not (Read-State)['chartBridge'].Contains('mixed') -and -not (Get-UpdateJson)['chartBridge']['mixed'] -and -not (Read-JsonFile $script:P.Status)['alert']) 'whole again: cleared'
  Assert ((Get-UpdateJson)['chartBridge']['ready'] -eq $vNext1) "and $vNext1 is ready again"
}
Test '-InstallChartBridge cut off between its replaces (a power loss): the next run finds the mix from the hashes and says DO NOT press F5' {
  $before = Get-AddOnsPrint
  $script:CrashAt = 'addon:1'; $script:PowerLost = $false; $script:Yes = $true
  try { [void](Invoke-InstallChartBridge) } catch { } finally { $script:CrashAt = ''; $script:PowerLost = $false; $script:Yes = $false }
  Assert ((Get-AddOnMarks) -eq 'new/old/old') "cut after the first replace: $(Get-AddOnMarks)"
  $r = Run-Update
  Assert ((Read-State)['chartBridge']['mixed'] -and (Get-UpdateJson)['chartBridge']['mixed'] -eq $true -and (Read-JsonFile $script:P.Status)['alert'] -match '^DO NOT press F5') 'found by the next run: state, the page and status.json'
  Assert ((Get-Text $script:P.Log) -match 'was cut off half way: ChartBridge\.cs changed') 'the log'
  # -InstallChartBridge again with nothing held: all three copied, one whole set, the mix is cleared
  $script:Yes = $true
  try { $code = Invoke-InstallChartBridge } finally { $script:Yes = $false }
  Assert-Code $code 0 'OK'
  Assert ((Get-AddOnMarks) -eq 'new/new/new') "all three new: $(Get-AddOnMarks)"
  foreach ($n in $script:AddOnNames) { Assert (Get-TextSame (Join-Path $script:P.AddOns $n) (Get-LocalPath $src "nt8/$n")) "$n is the commit's" }
  $s = Read-State
  Assert (-not $s['chartBridge'].Contains('mixed') -and $s['chartBridge']['installed']['version'] -eq $vNext1 -and (Get-UpdateJson)['chartBridge']['copied'] -eq $vNext1) 'copied, waiting for F5; no mix'
  Assert (@(Get-ChildItem -Recurse -LiteralPath $script:P.PrevAddOns -Filter 'ChartBridge.cs' | Where-Object { (Get-Text $_.FullName) -match "Version = ""$(Rx $vNext0)""" }).Count -ge 1) "the $vNext0 files are kept"
  $script:FakeDiag = $vNext1
  [void](Run-Update)
}
Test 'a cut after the last replace: the next run counts the copy (all files are the new ones)' {
  [void](Commit "ChartBridge $vNext2" { Set-CbVersion $vNext2 })
  [void](Run-Update)
  $script:CrashAt = 'addon:3'; $script:PowerLost = $false; $script:Yes = $true
  try { [void](Invoke-InstallChartBridge) } catch { } finally { $script:CrashAt = ''; $script:PowerLost = $false; $script:Yes = $false }
  [void](Run-Update)
  $s = Read-State
  Assert (-not $s['chartBridge'].Contains('mixed') -and $s['chartBridge']['installed']['version'] -eq $vNext2 -and (Get-UpdateJson)['chartBridge']['copied'] -eq $vNext2) 'counted as copied, waiting for F5'
  $script:FakeDiag = $vNext2
  [void](Run-Update)
}
Test '-InstallChartBridge: a commit that drops an add-on file (a revert of daily bars) takes it out of AddOns with the copy; a failed copy puts it back (review bars1 N2)' {
  [void](Commit "a revert: ChartBridgeBars.cs leaves the list (ChartBridge $vNext3)" {
    Set-CbVersion $vNext3
    Remove-Item -LiteralPath (Get-LocalPath $src 'nt8/ChartBridgeBars.cs') -Force
    $mf = Get-LocalPath $src 'nt8/install-files.json'
    Put $mf ((Get-Text $mf) -replace ',\s*"nt8/ChartBridgeBars\.cs"', '')
  })
  [void](Run-Update)
  $stage = Read-JsonFile (Join-Path $script:P.Staged 'stage.json')
  Assert ($stage['chartBridgeVersion'] -eq $vNext3 -and @($stage['addonFiles']).Count -eq @((Read-JsonFile (Get-LocalPath $src 'nt8/install-files.json'))['addons']).Count -and @($stage['addonFiles']) -notcontains 'ChartBridgeBars.cs') "staged $vNext3 without ChartBridgeBars.cs: $(@($stage['addonFiles']) -join ', ')"
  Assert (Test-Path -LiteralPath (Join-Path $script:P.AddOns 'ChartBridgeBars.cs')) "the $vNext2 install left ChartBridgeBars.cs in AddOns"
  # the probe: the copy fails on its third file; the file taken out and the one replaced are both put back
  $before = Get-AddOnsPrint
  $script:HoldAddOn = 'ChartBridgeOrders.cs'; $script:Yes = $true
  try { $code = Invoke-InstallChartBridge } finally { $script:HoldAddOn = ''; $script:Yes = $false }
  Assert-Code $code 1 'STOP (nothing changed)'
  $log = Get-Text $script:P.Log
  Assert ($log -match "ChartBridgeBars\.cs is not in ChartBridge $(Rx $vNext3)'s file list: taken out of AddOns" -and $log -match 'the add-on copy failed after 2 of \d+ files .*putting back: ChartBridgeBars\.cs, ChartBridge\.cs') 'taken out first, then put back with ChartBridge.cs'
  Assert ((Get-AddOnsPrint) -eq $before) 'AddOns exactly as before, ChartBridgeBars.cs included'
  Assert (-not (Read-State)['chartBridge'].Contains('mixed')) 'no mix'
  # an install recorded before 0.3.7 has no file list: the list is read from that install's commit
  $s = Read-State; $s['chartBridge']['installed'].Remove('files'); Save-State $s
  $script:Yes = $true
  try { $code = Invoke-InstallChartBridge } finally { $script:Yes = $false }
  Assert-Code $code 0 'OK'
  Assert (-not (Test-Path -LiteralPath (Join-Path $script:P.AddOns 'ChartBridgeBars.cs'))) "ChartBridgeBars.cs is gone from AddOns: NinjaTrader compiles one whole $vNext3"
  foreach ($n in $script:AddOnNames) { Assert (Get-TextSame (Join-Path $script:P.AddOns $n) (Get-LocalPath $src "nt8/$n")) "$n is the commit's" }
  Assert ((Get-Text (Join-Path $script:P.AddOns 'SomethingElse.cs')) -match 'another add-on') 'other add-ons untouched'
  $kept = @(Get-ChildItem -Recurse -LiteralPath $script:P.PrevAddOns -Filter 'ChartBridgeBars.cs')
  Assert ($kept.Count -ge 1) 'its copy is kept in the backup'
  $inst = (Read-State)['chartBridge']['installed']
  Assert ($inst['version'] -eq $vNext3 -and (@($inst['files']) -join ',') -eq ((@((Read-JsonFile (Get-LocalPath $src 'nt8/install-files.json'))['addons']) | ForEach-Object { Split-Path -Leaf $_ }) -join ',')) "the install records its file list: $(@($inst['files']) -join ',')"
  $script:FakeDiag = $vNext3
  [void](Run-Update)
}
Test 'status keeps what /diag said (a page waiting for F5 then follows on the next run)' {
  $s = Read-State; $s['chartBridge']['diagVersion'] = $vPc; Save-State $s
  $script:FakeDiag = $vNext0
  [void](Invoke-Status)
  Assert ((Read-State)['chartBridge']['diagVersion'] -eq $vNext0) 'saved'
}
Test 'status takes the lock before it reads state.json: while a run works it saves nothing (review 3 N-e)' {
  $s = Read-State; $s['chartBridge']['diagVersion'] = $vPc; Save-State $s
  $script:FakeDiag = $vNext2
  $held = Enter-Lock
  try {
    [void](Get-Said)
    [void](Invoke-Status)
    Assert ((Get-Said) -match 'another run is working') 'says so'
    Assert ((Read-State)['chartBridge']['diagVersion'] -eq $vPc) 'nothing saved under a running run'
  } finally { $held.Dispose() }
  [void](Invoke-Status)
  Assert ((Read-State)['chartBridge']['diagVersion'] -eq $vNext2) 'saved once the lock is free'
}
Test 'register offline never pins an older updater than the pinned one (review 3 N-b)' {
  $keepSelf = $script:UpdaterSelf
  [void](Commit 'docs, updater unchanged' { Put (Get-LocalPath $src 'nt8/NOTES.txt') "docs 11`n" })
  [void](Run-Update)
  $newer = Commit 'a newer updater' { Put (Get-LocalPath $src 'nt8/update-pc.ps1') ((Get-Text (Get-LocalPath $src 'nt8/update-pc.ps1')) + "`n# a newer updater`n") }
  [void](Run-Update)
  [void](Invoke-PinForTask '17:05')
  $pj = Join-Path $script:P.Bin 'pinned.json'
  Assert ((Read-JsonFile $pj)['commit'] -eq $newer) 'the newer updater is pinned'
  $pinnedHash = Get-Hash (Join-Path $script:P.Bin 'update-pc.ps1')
  # offline (main cannot be staged), and the running file is an older green commit's updater
  $script:FakeCi = 'pending'
  [void](Commit 'CI running' { Put (Get-LocalPath $src 'nt8/NOTES.txt') "docs 12`n" })
  Remove-Dir $script:P.Staged
  try {
    $threw = ''
    try { [void](Invoke-PinForTask '17:05') } catch { $threw = $_.Exception.Message }
    Assert ($threw -match 'not newer than the pinned' -and $threw -match (Get-Short $newer)) "refused: $threw"
    Assert ((Read-JsonFile $pj)['commit'] -eq $newer -and (Get-Hash (Join-Path $script:P.Bin 'update-pc.ps1')) -eq $pinnedHash) 'the pinned copy did not change'
    # the pinned file itself may be pinned again (register from the task's own copy)
    $script:UpdaterSelf = Join-Path $script:P.Bin 'update-pc.ps1'
    [void](Invoke-PinForTask '17:05')
    Assert ((Read-JsonFile $pj)['commit'] -eq $newer) 'the same file: kept at its commit'
  } finally { $script:UpdaterSelf = $keepSelf; $script:FakeCi = 'success' }
  [void](Commit 'the updater back as in this repo' { Put (Get-LocalPath $src 'nt8/update-pc.ps1') (Get-Text $keepSelf) })
  [void](Run-Update)
  [void](Invoke-PinForTask '17:05')
}
Test 'repair''s last resort (the clone''s page) passes the ChartBridge check, or says plainly it was not checked (review 3 N-c)' {
  $script:FakeDiag = $vNext2
  [void](Run-Update)
  $cloneCompat = Get-LocalPath $clone 'live/COMPAT.json'
  $keepCompat = Get-Text $cloneCompat
  # staged\ and previous\ unusable, www not the installed build: only the clone is left
  Put (Get-LocalPath (Join-Path $script:P.Staged 'page') 'live.js') 'spoiled'
  Put (Get-LocalPath (Join-Path $script:P.Previous 'page') 'live.js') 'spoiled'
  Put (Get-WwwFile 'live.js') 'spoiled www'
  try {
    Put $cloneCompat ([regex]::Replace($keepCompat, '"minChartBridge": "[^"]+"', '"minChartBridge": "9.9.9"'))
    [void](Get-Said)
    Assert-Code (Invoke-Repair) 1 'refused'
    $said = Get-Said
    Assert ($said -match 'nothing written' -and $said -match "needs ChartBridge 9\.9\.9; this PC has $(Rx $vNext2)" -and $said -match 'the clone \(main at [0-9a-f]{7}\)') "says why, with the clone's branch and commit: $said"
    Assert ((Get-Text (Get-WwwFile 'live.js')) -eq 'spoiled www') 'nothing written'
    Put $cloneCompat $keepCompat
    $s = Read-State; $keepCb = $s['chartBridge']; $s['chartBridge'] = @{}; Save-State $s
    $script:FakeDiag = $null
    Assert-Code (Invoke-Repair) 0 'the version here unknown: written'
    $said = Get-Said
    Assert ($said -match 'NOT checked against ChartBridge' -and $said -match 'the clone \(main at [0-9a-f]{7}\)') "and says plainly that it was not checked: $said"
    $s = Read-State; $s['chartBridge'] = $keepCb; Save-State $s
    $script:FakeDiag = $vNext2
    Put (Get-WwwFile 'live.js') 'spoiled www'
    Assert-Code (Invoke-Repair) 0 'the version here known and new enough: written'
    Assert ((Get-Said) -match "It needs ChartBridge $(Rx $vMin); this PC has $(Rx $vNext2): checked") 'says it was checked'
  } finally { Put $cloneCompat $keepCompat; $script:FakeDiag = $vNext2 }
  Remove-Dir $script:P.Staged
  Assert ((Run-Update).outcome -eq 'updated') 'installs again'
}
Test 'a run cut off just after state.json is saved: the page reads installed (the hashes match), never "cut off"' {
  [void](New-MarkCommit 400)
  $out = Invoke-Cut 'after-state'
  Assert (Test-Path $script:P.Journal) "cut off with the journal open ($out)"
  $u = Get-UpdateJson
  Assert ($u['page']['state'] -eq '' -and $u['page']['build'] -eq (Read-JsonFile $script:P.Journal)['target']['build']) "update.json says installed: '$($u['page']['state'])'"
  [void](Get-Said)
  [void](Invoke-Status)
  Assert ((Get-Said) -match 'the page is whole; the next update closes the journal') 'status does not call it cut off'
  $r = Run-Update
  Assert ($r.recovered -eq 'finished') "the next run closes it: $($r.recovered)"
  Assert-Whole 'after the close'
  # cut after the files, before the state: update.json still says installing, and the end of a run that meets the
  # open journal (Write-UpdateJson) re-checks the hashes and says installed
  [void](New-MarkCommit 401)
  $out = Invoke-Cut 'after-files'
  Assert ((Get-UpdateJson)['page']['state'] -eq 'installing') 'installing at the cut'
  $s = Read-State
  Write-UpdateJson $s (Get-ChartBridgeNotice $s @{ version = $vNext2; source = 'diag' })
  Assert ((Get-UpdateJson)['page']['state'] -eq '') 'the files are whole: installed'
  [void](Run-Update)
  Assert-Whole 'after the close (2)'
}
Test 'a daily-trigger move that fails is recorded, and status shows when (review 3 N-g)' {
  $s = Read-State
  Save-TriggerCheck $s @{ at = (Get-NowMs) - 86400000; ok = $false; have = '17:05'; want = '16:05'; error = 'Access is denied.' }
  Save-TriggerCheck $s @{ at = (Get-NowMs); ok = $false; have = '17:05'; want = '16:05'; error = 'Access is denied.' }
  Assert ($s['dailyTrigger']['failingSince'] -lt $s['dailyTrigger']['failedAt']) 'failing since the first failure'
  Save-State $s
  [void](Get-Said)
  [void](Invoke-Status)
  $said = Get-Said
  Assert ($said -match 'the last move FAILED at' -and $said -match 'Access is denied' -and $said -match 'not elevated') "status: $said"
  $s = Read-State
  Save-TriggerCheck $s @{ at = (Get-NowMs); ok = $true; have = '17:05'; want = '17:05'; error = '' }
  Assert (-not $s['dailyTrigger'].Contains('failedAt')) 'a good check clears it'
  Save-State $s
}
Test 'StartBoundary is read as written: the wall-clock time, and whether it carries a UTC offset (review 3 S2)' {
  $a = Read-StartBoundary '2026-09-30T17:05:00-04:00'
  Assert ($a.ok -and $a.hhmm -eq '17:05' -and $a.offset) 'with an offset: kept on UTC'
  $b = Read-StartBoundary '2026-09-30T17:05:00'
  Assert ($b.ok -and $b.hhmm -eq '17:05' -and -not $b.offset) 'local wall-clock time'
  Assert ((Read-StartBoundary '2026-12-15T22:05:00Z').offset) 'Z is an offset'
  Assert (-not (Read-StartBoundary 'junk').ok) 'junk'
  # the reviewer's p6: in New York, a trigger written in September with -04:00 fires at 16:05 in December; the string
  # says 17:05 either way, which is why the offset itself counts as drift
  $utc = ([DateTimeOffset]::Parse('2026-09-30T17:05:00-04:00')).UtcDateTime
  $ny = $null; foreach ($id in @('Eastern Standard Time', 'America/New_York')) { try { $ny = [TimeZoneInfo]::FindSystemTimeZoneById($id); break } catch { } }
  $dec = [TimeZoneInfo]::ConvertTimeFromUtc((New-Object DateTime(2026, 12, 15, $utc.Hour, $utc.Minute, 0, [DateTimeKind]::Utc)), $ny)
  Assert ($dec.ToString('HH:mm') -eq '16:05') "kept on UTC it would fire at $($dec.ToString('HH:mm')) New York time in December"
}
Test 'the write order: the engine first, the libraries and styles, live.js, index.html last' {
  $o = Get-PageOrder @('index.html', 'live.js', 'live.css', 'bar-builder.js', 'src/chart-engine.js', 'update-notice.js', 'pin.css', 'order-ticket.js', 'pin.js')
  Assert ($o[0] -eq 'src/chart-engine.js' -and $o[$o.Count - 1] -eq 'index.html') ($o -join ',')
  Assert ([array]::IndexOf($o, 'live.js') -gt [array]::IndexOf($o, 'bar-builder.js') -and [array]::IndexOf($o, 'live.js') -gt [array]::IndexOf($o, 'live.css')) ($o -join ',')
  # the workspace (index.html since E2a): its script after live.js, another page (the Agent tab's pop-out) next to last
  $w = Get-PageOrder @('index.html', 'agent.html', 'workspace.js', 'feed.js', 'live.js', 'workspace.css', 'src/chart-engine.js')
  Assert ($w[$w.Count - 1] -eq 'index.html' -and $w[$w.Count - 2] -eq 'agent.html') ($w -join ',')
  Assert ([array]::IndexOf($w, 'workspace.js') -gt [array]::IndexOf($w, 'live.js') -and [array]::IndexOf($w, 'feed.js') -lt [array]::IndexOf($w, 'live.js')) ($w -join ',')
}

# ---------------------------------------------------------------------------------------------- 0.3.8: a network not up yet, a held files.zip

$script:Waits = New-Object System.Collections.ArrayList
$script:RealGit = ${function:Invoke-Git}
$script:RealWait = ${function:Wait-Ms}
$script:NetDown = 0; $script:FetchErr = ''; $script:Fetches = 0
function Use-FlakyFetch {
  ${function:script:Wait-Ms} = { param([int]$Ms) [void]$script:Waits.Add($Ms) }
  ${function:script:Invoke-Git} = {
    param([string[]]$ArgList, [int]$TimeoutSec = 120)
    if ($ArgList[0] -eq 'fetch') {
      $script:Fetches++
      if ($script:NetDown -ne 0) { $script:NetDown--; return @{ code = 128; out = ''; err = $script:FetchErr } }
    }
    return (& $script:RealGit $ArgList $TimeoutSec)
  }
}
function Reset-FlakyFetch { ${function:script:Invoke-Git} = $script:RealGit; ${function:script:Wait-Ms} = $script:RealWait; $script:NetDown = 0; $script:Waits.Clear(); $script:Fetches = 0 }
$script:NoNet = "fatal: unable to access 'https://github.com/owner/chart-engine/': Failed to connect to github.com port 443 after 21 ms: Couldn't connect to server"

Test 'sign-in before the network is up: the fetch is tried again every 10 s, and the run carries on once it is up' {
  Use-FlakyFetch
  try {
    $script:NetDown = 3; $script:FetchErr = $script:NoNet
    $r = Run-Update
    Assert ($script:StopOutcomes -notcontains $r.outcome -and $r.outcome -ne 'offline') "$($r.outcome): $($r.reason)"
    Assert ($script:Fetches -eq 4 -and $script:Waits.Count -eq 3 -and @($script:Waits | Where-Object { $_ -ne 10000 }).Count -eq 0) "fetches $($script:Fetches), waits $($script:Waits -join ',')"
  } finally { Reset-FlakyFetch }
}
Test 'no network for about 2 minutes: given up quietly (offline, INFO, OK), nothing changed, the next run tries again' {
  Use-FlakyFetch
  try {
    $before = Get-Text (Join-Path $script:P.Www 'update.json')
    $script:NetDown = -1; $script:FetchErr = $script:NoNet
    $logBefore = (Get-Text $script:P.Log).Length
    Assert-Code (Invoke-Update) 0 'not a STOP'
    $st = Read-JsonFile $script:P.Status
    Assert ($st['outcome'] -eq 'offline' -and $st['reason'] -match 'network was not up' -and $st['reason'] -match '13 tries') $st['reason']
    Assert ($script:Waits.Count -eq 12 -and ($script:Waits | Measure-Object -Sum).Sum -eq 120000) "waits $($script:Waits.Count)"
    $log = (Get-Text $script:P.Log).Substring($logBefore)
    Assert ($log -match 'INFO.*offline' -and $log -notmatch 'WARN') $log
    Assert ((Get-Text (Join-Path $script:P.Www 'update.json')) -eq $before) 'update.json untouched'
    Assert ($script:Toasts.Count -eq 0 -or $script:Toasts[-1] -notmatch 'network') 'no toast'
  } finally { Reset-FlakyFetch }
}
Test '-InstallChartBridge during the network wait is refused saying so (retry in about 2 minutes); the note goes with the wait' {
  Use-FlakyFetch
  $script:DuringWait = $null
  ${function:script:Wait-Ms} = { param([int]$Ms) [void]$script:Waits.Add($Ms); if ($null -eq $script:DuringWait) { $script:Yes = $true; try { $script:DuringWait = Invoke-InstallChartBridge; $script:DuringText = Get-Said } finally { $script:Yes = $false } } }
  try {
    $script:NetDown = 2; $script:FetchErr = $script:NoNet
    [void](Get-Said)
    Assert-Code (Invoke-Update) 0 'the update itself carries on'
    Assert-Code $script:DuringWait 1 'the install is refused (the lock is held)'
    Assert ($script:DuringText -match 'STOP: another update-pc.ps1 run is waiting for the network' -and $script:DuringText -match 'try again in about 2 minutes') $script:DuringText
    Assert (-not (Test-Path $script:P.NetWait)) 'the note is gone after the wait'
    Assert ((Get-BusyText) -match 'is working; try again in a minute') 'without the note: the usual text'
  } finally { Reset-FlakyFetch; $script:DuringWait = $null }
}
Test 'a fetch refused for another reason is not waited for (fetch_failed, a STOP); check never waits' {
  Use-FlakyFetch
  try {
    $script:NetDown = 1; $script:FetchErr = "remote: Repository not found.`nfatal: repository 'https://github.com/owner/chart-engine/' not found"
    $r = Run-Update
    Assert ($r.outcome -eq 'fetch_failed' -and $script:Waits.Count -eq 0 -and $script:Fetches -eq 1) "$($r.outcome) waits $($script:Waits.Count)"
    $script:NetDown = 1; $script:FetchErr = $script:NoNet; $script:Fetches = 0
    $s = Read-State; $r = Invoke-Pass -DryRun -State $s
    Assert ($r.outcome -eq 'offline' -and $script:Waits.Count -eq 0 -and $script:Fetches -eq 1) "check: $($r.outcome) waits $($script:Waits.Count)"
    Assert ((Test-NetworkDown 'fatal: unable to access ''https://github.com/x/'': Could not resolve host: github.com') -and (Test-NetworkDown 'ssh: connect to host github.com port 22: Network is unreachable') -and -not (Test-NetworkDown 'fatal: Authentication failed')) 'network errors told apart'
  } finally { Reset-FlakyFetch }
}
Test 'staged.tmp\files.zip held by an antivirus for a moment: its delete is tried again, and staging carries on' {
  $keepIntact = ${function:Test-StagedIntact}; $keepDel = ${function:Remove-FileOnce}
  $script:Held = 2; $script:DelTries = 0
  ${function:script:Wait-Ms} = { param([int]$Ms) [void]$script:Waits.Add($Ms) }
  ${function:script:Test-StagedIntact} = { param($Stage) $false }
  ${function:script:Remove-FileOnce} = { param([string]$Path) $script:DelTries++; if ($Path -like '*files.zip' -and $script:Held -gt 0) { $script:Held--; throw (New-Object System.UnauthorizedAccessException "Access to the path '$Path' is denied.") }; Remove-Item -LiteralPath $Path -Force }
  try {
    $info = Get-CommitInfo (G $clone @('rev-parse', 'refs/remotes/origin/main'))
    $st = Invoke-Stage $info
    Assert ($st -and (Get-Field $st 'commit') -eq $info.commit) 'staged'
    Assert ($script:DelTries -eq 3 -and $script:Waits.Count -eq 2 -and $script:Waits[0] -eq 500) "tries $($script:DelTries), waits $($script:Waits -join ',')"
    Assert (-not (Test-Path (Join-Path $script:P.Staged 'files.zip'))) 'no zip left in staged'
    $script:Held = 99; $script:Waits.Clear(); $threw = ''
    try { [void](Invoke-Stage $info) } catch { $threw = $_.Exception.Message }
    Assert ($threw -match 'after 10 tries over about 5 s' -and $threw -match 'denied' -and $script:Waits.Count -eq 9) $threw
  } finally {
    ${function:script:Test-StagedIntact} = $keepIntact; ${function:script:Remove-FileOnce} = $keepDel; Reset-FlakyFetch
    Remove-Dir (Join-Path $script:P.Dir 'staged.tmp')
  }
}

# ---------------------------------------------------------------------------------------------- the rest

Test 'one run at a time' {
  $held = Enter-Lock
  try { Assert-Code (Invoke-Update) 1 'a second run stops' } finally { $held.Dispose() }
}
Test 'the manifest check refuses paths outside www, .cs page files and odd add-on entries' {
  foreach ($bad in @(
      @{ addons = @('nt8/ChartBridge.cs'); www = @(@{ from = 'live/a.js'; to = '../a.js' }) },
      @{ addons = @('nt8/ChartBridge.cs'); www = @(@{ from = 'nt8/ChartBridge.cs'; to = 'x.cs' }) },
      @{ addons = @('live/live.js'); www = @(@{ from = 'live/a.js'; to = 'a.js' }) },
      @{ addons = @('nt8/ChartBridge.cs'); www = @(@{ from = 'live/a.js'; to = 'update.json' }) },
      @{ addons = @('nt8/ChartBridge.cs'); www = @(@{ from = 'live/a.js'; to = 'x.cs.' }) },
      @{ addons = @('nt8/ChartBridge.cs'); www = @(@{ from = 'live/a.js'; to = 'a.js ' }) },
      @{ addons = @('nt8/ChartBridge.cs'); www = @(@{ from = 'live/a.js'; to = 'src/../../a.js' }) })) {
    $threw = $false
    try { Test-Manifest $bad } catch { $threw = $true }
    Assert $threw "refused $(ConvertTo-Json $bad -Compress -Depth 5)"
  }
  Test-Manifest $manifest
}
Test 'config.txt, pin.txt and Anthony''s own www file were never touched' {
  Assert ((Get-Hash $script:P.Config) -eq $configHash) 'config.txt'
  Assert ((Get-Hash (Join-Path $cbDir 'pin.txt')) -eq $pinHash) 'pin.txt'
  Assert ((Get-Hash (Get-WwwFile 'anthony-notes.txt')) -eq $notesHash) 'notes'
}
Test 'nothing private in www\update.json' {
  $t = Get-Text (Join-Path $script:P.Www 'update.json')
  Assert ($t -notmatch [regex]::Escape($tmpRoot) -and $t -notmatch 'config|pin\.txt|token') 'versions only'
}
Test 'the command line runs under this PowerShell with -File and ends in OK or STOP (status writes no page or ChartBridge file)' {
  $exe = (Get-Process -Id $PID).Path
  $r = Invoke-Native $exe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path (Join-Path $repoRoot 'nt8') 'update-pc.ps1'), 'status') 300
  $last = Get-LastLine $r.out
  Assert ($last -match '^(OK|STOP): ') "last line OK or STOP: $last $($r.err)"
  Assert (($r.code -eq 0) -eq ($last -match '^OK')) "exit code $($r.code) matches"
}

# ---------------------------------------------------------------------------------------------- the scheduled task

Test 'the daily time: 17:05 New York is 21:05 UTC in summer and 22:05 UTC in winter' {
  Assert ((ConvertFrom-NewYorkTime '17:05' ([datetime]'2026-07-15')).ToUniversalTime().ToString('HH:mm') -eq '21:05') 'summer (EDT)'
  Assert ((ConvertFrom-NewYorkTime '17:05' ([datetime]'2026-12-15')).ToUniversalTime().ToString('HH:mm') -eq '22:05') 'winter (EST)'
  Assert ((ConvertFrom-NewYorkTime '09:30' ([datetime]'2026-12-15')).ToUniversalTime().ToString('HH:mm') -eq '14:30') 'another time'
}

Test 'the daily times are 09:00 and 17:00 New York by default (Anthony 2026-10-23), an explicit -DailyAt wins, and an old pin reads as Get-PinTimes says' {
  Assert ((@($DailyAt) -join '|') -eq '09:00,17:00' -and $script:DailyAtDefault -eq '09:00,17:00') "default $DailyAt / $($script:DailyAtDefault)"
  $exe = (Get-Process -Id $PID).Path
  $probe = Join-Path $tmpRoot 'dailyat-probe.ps1'
  Put $probe ("param([string]`$At = '')`n`$a = @{ NoRun = `$true }`nif (`$At) { `$a['DailyAt'] = `$At }`n. '" + (Join-Path (Join-Path $repoRoot 'nt8') 'update-pc.ps1').Replace("'", "''") + "' @a`n[Console]::Out.WriteLine('DAILYAT=' + ((Get-DailyTimes `$DailyAt) -join '+'))`n")
  $r = Invoke-Native $exe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $probe) 120
  Assert ($r.out -match 'DAILYAT=09:00\+17:00') "the default: $($r.out) $($r.err)"
  $r = Invoke-Native $exe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $probe, '-At', '17:05') 120
  Assert ($r.out -match 'DAILYAT=17:05\s') "explicit, one time: $($r.out) $($r.err)"
  $r = Invoke-Native $exe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $probe, '-At', '17:00,08:30') 120
  Assert ($r.out -match 'DAILYAT=08:30\+17:00') "explicit, a list (sorted): $($r.out) $($r.err)"
  # -File on update-pc.ps1 itself: one argument 09:00,17:00 binds as the list; a bad time is refused before anything runs
  $upd = Join-Path (Join-Path $repoRoot 'nt8') 'update-pc.ps1'
  $r = Invoke-Native $exe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $upd, 'pause', '-NoRun', '-DailyAt', '09:00,17:00') 120
  Assert ($r.code -eq 0) "-File with -DailyAt 09:00,17:00 binds: $($r.out) $($r.err)"
  $r = Invoke-Native $exe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $upd, 'pause', '-NoRun', '-DailyAt', '9:00,17:00') 120
  Assert ($r.code -ne 0 -and "$($r.out)$($r.err)" -match 'DailyAt') "a bad time is refused: $($r.code) $($r.out) $($r.err)"
  # a PC registered before: a pin with dailyAt alone (an older copy wrote it) reads 09:00 and 17:00 when it held an old
  # default (09:00, 17:05) or none, and keeps another time; -InstallChartBridge re-pins with what it reads
  $pj = Join-Path $script:P.Bin 'pinned.json'
  $keep = Get-Text $pj
  try {
    foreach ($case in @(@('17:05', '09:00', '09:00,17:00'), @('09:00', '09:00', '09:00,17:00'), @('', '09:00', '09:00,17:00'), @('08:30', '08:30', '08:30'))) {
      $pin = Read-JsonFile $pj; $pin.Remove('dailyTimes'); if ($case[0]) { $pin['dailyAt'] = $case[0] } else { $pin.Remove('dailyAt') }; Write-JsonAtomic $pj $pin
      [void](Install-PinnedUpdater (Join-Path $script:P.Bin 'update-pc.ps1') ([string]$pin['commit']) ([string]$pin['blob']) '-InstallChartBridge')
      $now = Read-JsonFile $pj
      Assert ($now['dailyAt'] -eq $case[1] -and (@($now['dailyTimes']) -join ',') -eq $case[2]) "an old pin with '$($case[0])': dailyAt $($now['dailyAt']), dailyTimes $(@($now['dailyTimes']) -join ',')"
    }
    # a pin of this version keeps its times, one or two
    $pin = Read-JsonFile $pj; Set-PinTimes $pin '09:00'; Write-JsonAtomic $pj $pin
    [void](Install-PinnedUpdater (Join-Path $script:P.Bin 'update-pc.ps1') ([string]$pin['commit']) ([string]$pin['blob']) '-InstallChartBridge')
    Assert ((@((Read-JsonFile $pj)['dailyTimes']) -join ',') -eq '09:00') 'one time given by hand stays one'
  } finally { Put $pj $keep }
}

Test 'Get-DailyTimes and Get-PinTimes: a list or one time, sorted, each once; an older copy''s pin; a stale dailyTimes' {
  Assert ((@(Get-DailyTimes '17:00,09:00') -join '|') -eq '09:00|17:00') 'a command line list, sorted'
  Assert ((@(Get-DailyTimes @('17:00', '09:00', '09:00')) -join '|') -eq '09:00|17:00') 'a PowerShell list, each once'
  Assert (@(Get-DailyTimes '08:30').Count -eq 1) 'one time'
  foreach ($bad in @('', '9:00', '09:00,25:00', 'noon')) { $threw = $false; try { [void](Get-DailyTimes $bad) } catch { $threw = $true }; Assert $threw "refused: '$bad'" }
  Assert ((@(Get-PinTimes $null) -join ',') -eq '09:00,17:00') 'no pin: the default'
  Assert ((@(Get-PinTimes @{ dailyAt = '09:00'; dailyTimes = @('09:00') }) -join ',') -eq '09:00') 'this version: one time kept'
  Assert ((@(Get-PinTimes @{ dailyAt = '09:00'; dailyTimes = @('09:00', '17:00') }) -join ',') -eq '09:00,17:00') 'this version: both'
  # an older copy's register wrote dailyAt after this version wrote dailyTimes: dailyAt wins (it is newer)
  Assert ((@(Get-PinTimes @{ dailyAt = '08:30'; dailyTimes = @('09:00', '17:00') }) -join ',') -eq '08:30') 'a stale dailyTimes'
  $p = @{}; Set-PinTimes $p '17:00,09:00'
  $back = ConvertFrom-JsonText (ConvertTo-Json -InputObject $p -Depth 4)
  Assert ($back['dailyAt'] -eq '09:00' -and (@($back['dailyTimes']) -join ',') -eq '09:00,17:00') 'written: dailyAt (for an older copy) and dailyTimes'
  $p = @{}; Set-PinTimes $p '08:30'
  $back = ConvertFrom-JsonText (ConvertTo-Json -InputObject $p -Depth 4)
  Assert ((@(Get-PinTimes $back) -join ',') -eq '08:30') 'one time round trips through JSON'
}

# The scheduled task's commands, stubbed (no task is ever made or touched here): each records what it was given. A test
# dot-sources $script:TaskStubs into its own body, so the stubs live in that body's scope and are gone when it ends, on
# Windows PowerShell 5.1 as on pwsh (a stub left behind would answer the Windows-only tests below in place of the real
# ScheduledTasks commands).
$script:TaskCalls = New-Object System.Collections.ArrayList
$script:StubTask = $null
$script:TaskStubs = {
  $script:TaskCalls.Clear(); $script:StubTask = $null
  function New-ScheduledTaskAction { param([string]$Execute, [string]$Argument, [string]$WorkingDirectory) [void]$script:TaskCalls.Add(@{ cmd = 'action'; Execute = $Execute; Argument = $Argument; WorkingDirectory = $WorkingDirectory }); return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory } }
  function New-ScheduledTaskTrigger { param([switch]$AtLogOn, [string]$User, [switch]$Daily, [datetime]$At) return [pscustomobject]@{ Kind = $(if ($AtLogOn) { 'logon' } else { 'daily' }); User = $User; At = $At; Delay = $null; StartBoundary = $null } }
  function New-ScheduledTaskPrincipal { param([string]$UserId, [string]$LogonType, [string]$RunLevel) return [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel } }
  function New-ScheduledTaskSettingsSet { param([string]$MultipleInstances, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, [switch]$StartWhenAvailable, [TimeSpan]$ExecutionTimeLimit) return [pscustomobject]@{ MultipleInstances = $MultipleInstances; AllowStartIfOnBatteries = [bool]$AllowStartIfOnBatteries; DontStopIfGoingOnBatteries = [bool]$DontStopIfGoingOnBatteries; StartWhenAvailable = [bool]$StartWhenAvailable; ExecutionTimeLimit = $ExecutionTimeLimit } }
  function Register-ScheduledTask { param([string]$TaskName, $Action, $Trigger, $Principal, $Settings, [switch]$Force, [string]$Description) [void]$script:TaskCalls.Add(@{ cmd = 'register'; TaskName = $TaskName; Action = $Action; Trigger = @($Trigger); Principal = $Principal; Settings = $Settings; Force = [bool]$Force; Description = $Description }); $script:StubTask = [pscustomobject]@{ TaskName = $TaskName; Actions = @($Action); State = 'Ready' }; return $script:StubTask }
  function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName) [void]$script:TaskCalls.Add(@{ cmd = 'get'; TaskName = $TaskName }); return $script:StubTask }
  function Unregister-ScheduledTask { param([string]$TaskName, [switch]$Confirm) [void]$script:TaskCalls.Add(@{ cmd = 'unregister'; TaskName = $TaskName }); $script:StubTask = $null }
  function Set-ScheduledTask { throw 'Set-ScheduledTask was not expected here' }
}
function Get-TaskCall([string]$Cmd) { return @($script:TaskCalls | Where-Object { $_.cmd -eq $Cmd }) }

Test 'register (stubbed): the task runs wscript.exe //B on an ASCII one-line launcher that runs the same hidden PowerShell command, everything else as before' {
  $keepP = $script:P
  $docs = Join-Path $tmpRoot 'hid docs'
  $repoSp = Join-Path $tmpRoot 'my clone'
  Initialize-Paths $repoSp (Join-Path $docs 'NinjaTrader 8')
  . $script:TaskStubs
  try {
    $pinned = Join-Path $script:P.Bin 'update-pc.ps1'
    $local = ConvertFrom-NewYorkTime '09:00'
    Register-HiddenTask 'PC\anthony' $pinned $local
    $launcher = Join-Path $script:P.Bin 'update-pc.hidden.vbs'
    Assert ($launcher -match 'NinjaTrader 8' -and (Test-Path -LiteralPath $launcher)) "the launcher is in updater\bin: $launcher"
    $ps = Get-SystemExe 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if ($env:SystemRoot) { Assert ($ps -eq (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')) "the same powershell.exe as before: $ps" }
    $cmd = '"' + $ps + '" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $pinned + '" update -Repo "' + $repoSp + '"'
    Assert ($cmd -eq ('"' + $ps + '" ' + (Get-TaskArguments $pinned $repoSp))) "the command line is the task's old one: $cmd"
    $want = 'WScript.Quit CreateObject("WScript.Shell").Run("' + $cmd.Replace('"', '""') + '", 0, True)' + "`r`n"
    $bytes = [IO.File]::ReadAllBytes($launcher)
    Assert (@($bytes | Where-Object { $_ -gt 127 -or ($_ -lt 32 -and $_ -ne 13 -and $_ -ne 10) }).Count -eq 0) 'ASCII only, no BOM'
    $text = [Text.Encoding]::ASCII.GetString($bytes)
    Assert ($text -ceq $want) "the launcher's exact line:`n$text`nwanted`n$want"
    Assert (@($text.TrimEnd("`r", "`n").Split("`n")).Count -eq 1) 'one line'
    Assert ($text.Contains('-File ""' + $pinned + '"" update -Repo ""' + $repoSp + '""')) 'the paths with spaces, quoted and doubled'
    $reg = @(Get-TaskCall 'register')
    Assert ($reg.Count -eq 1) "one Register-ScheduledTask: $($reg.Count)"
    $r = $reg[0]
    Assert ($r.TaskName -eq 'ChartEngine Updater' -and $r.Force) "name and -Force: $($r.TaskName)"
    Assert ($r.Action.Execute -eq (Get-SystemExe 'System32\wscript.exe')) "wscript.exe: $($r.Action.Execute)"
    Assert ($r.Action.Arguments -ceq ('//B "' + $launcher + '"')) "batch mode (no WScript error dialog), the launcher quoted: $($r.Action.Arguments)"
    Assert ($r.Action.WorkingDirectory -eq $script:P.Bin) "the working folder as before: $($r.Action.WorkingDirectory)"
    Assert ($r.Trigger.Count -eq 2 -and $r.Trigger[0].Kind -eq 'logon' -and $r.Trigger[0].User -eq 'PC\anthony' -and $r.Trigger[0].Delay -eq 'PT2M') 'at sign-in, after 2 minutes'
    Assert ($r.Trigger[1].Kind -eq 'daily' -and $r.Trigger[1].StartBoundary -eq $local.ToString('yyyy-MM-ddTHH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)) "daily, wall-clock time: $($r.Trigger[1].StartBoundary)"
    Assert ($r.Principal.UserId -eq 'PC\anthony' -and $r.Principal.LogonType -eq 'Interactive' -and $r.Principal.RunLevel -eq 'Limited') 'only while signed in, no password, not elevated'
    $st = $r.Settings
    Assert ($st.MultipleInstances -eq 'IgnoreNew' -and $st.AllowStartIfOnBatteries -and $st.DontStopIfGoingOnBatteries -and -not $st.StartWhenAvailable -and $st.ExecutionTimeLimit -eq (New-TimeSpan -Minutes 30)) 'settings as before'
    Assert ($r.Description -ceq "Keeps the chart page in ChartBridge's www folder up to date (green commits on main only). Never installs ChartBridge. Log: $($script:P.Log)") 'the description as before'
    # again: idempotent, the same launcher, one more register
    Register-HiddenTask 'PC\anthony' $pinned $local
    Assert ([IO.File]::ReadAllText($launcher) -ceq $want -and @(Get-TaskCall 'register').Count -eq 2) 'register again: the same launcher'
    Assert ((Get-TaskLauncherPath $script:StubTask) -eq $launcher) 'the task names the launcher'
    # unregister: the task and the launcher
    Unregister-HiddenTask
    Assert (@(Get-TaskCall 'unregister').Count -eq 1 -and $null -eq $script:StubTask) 'the task removed'
    Assert (-not (Test-Path -LiteralPath $launcher)) 'the launcher removed'
    Unregister-HiddenTask
    Assert (@(Get-TaskCall 'unregister').Count -eq 1) 'unregister again: nothing to do'
  } finally { $script:P = $keepP }
}
Test 'register (stubbed): a launcher that cannot be written stops register before the task is touched' {
  $keepP = $script:P
  Initialize-Paths (Join-Path $tmpRoot 'clone2') (Join-Path $tmpRoot 'nt-hid-fail')
  . $script:TaskStubs
  try {
    $launcher = Join-Path $script:P.Bin 'update-pc.hidden.vbs'
    New-Item -ItemType Directory -Force -Path $launcher | Out-Null      # a folder where the file goes: the write fails
    $threw = ''
    try { Register-HiddenTask 'PC\anthony' (Join-Path $script:P.Bin 'update-pc.ps1') (Get-Date) } catch { $threw = $_.Exception.Message }
    Assert ($threw -match 'hidden launcher could not be written, the task was not changed') "failed loudly: $threw"
    Assert (@(Get-TaskCall 'register').Count -eq 0 -and @(Get-TaskCall 'action').Count -eq 0) 'no task made or changed'
    Remove-Item -LiteralPath $launcher -Force
    # a path a launcher cannot hold as written: refused, not changed
    foreach ($bad in @(('clone ' + [char]0x00E9), 'clone %USERNAME%')) {
      Initialize-Paths (Join-Path $tmpRoot $bad) (Join-Path $tmpRoot 'nt-hid-fail')
      $threw = ''
      try { Register-HiddenTask 'PC\anthony' (Join-Path $script:P.Bin 'update-pc.ps1') (Get-Date) } catch { $threw = $_.Exception.Message }
      Assert ($threw -match 'could not be written' -and -not (Test-Path -LiteralPath $launcher)) "refused for '$bad': $threw"
    }
    Assert (@(Get-TaskCall 'register').Count -eq 0) 'still no task'
  } finally { $script:P = $keepP }
}
Test 'unregister (stubbed) removes a launcher the task names only when it is ours' {
  $keepP = $script:P
  Initialize-Paths (Join-Path $tmpRoot 'clone3') (Join-Path $tmpRoot 'nt-hid-un')
  . $script:TaskStubs
  try {
    $other = Join-Path $tmpRoot 'hidden-by-hand'
    New-Item -ItemType Directory -Force -Path $other | Out-Null
    $hand = Join-Path $other 'chartengine_updater.vbs'
    Put $hand "hand made`r`n"
    $script:StubTask = [pscustomobject]@{ TaskName = 'ChartEngine Updater'; Actions = @([pscustomobject]@{ Execute = 'C:\Windows\System32\wscript.exe'; Arguments = '"' + $hand + '"' }); State = 'Ready' }
    Assert ((Get-TaskLauncherPath $script:StubTask) -eq '') 'a hand-made launcher is not ours'
    Unregister-HiddenTask
    Assert ((Test-Path -LiteralPath $hand) -and @(Get-TaskCall 'unregister').Count -eq 1) 'the task removed, the hand-made launcher left'
    $mine = Join-Path $other 'update-pc.hidden.vbs'
    Put $mine "x`r`n"
    $script:StubTask = [pscustomobject]@{ TaskName = 'ChartEngine Updater'; Actions = @([pscustomobject]@{ Execute = 'C:\Windows\System32\wscript.exe'; Arguments = '//B "' + $mine + '"' }); State = 'Ready' }
    Unregister-HiddenTask
    Assert (-not (Test-Path -LiteralPath $mine)) 'ours, where the task named it: removed'
  } finally { $script:P = $keepP }
}

Test 'Split-CommandLine reads back what Format-Arg writes (spaces, quotes, trailing backslashes, empty)' {
  foreach ($set in @(@('C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe', '-File', 'C:\Users\a b\Documents\NinjaTrader 8\x.ps1', 'update', '-Repo', 'C:\my clone\'),
      @('a"b', 'c\"d', 'e f\\', '', 'plain'))) {
    $line = (@($set | ForEach-Object { Format-Arg $_ }) -join ' ')
    $back = @(Split-CommandLine $line)
    Assert ($back.Count -eq $set.Count) "count: $($back.Count) of $($set.Count) from $line"
    for ($i = 0; $i -lt $set.Count; $i++) { Assert ($back[$i] -ceq $set[$i]) "token $i '$($back[$i])' from $line" }
  }
}

# A task as Get-ScheduledTask returns it, for the option checks: its action only.
function New-FakeTask([string]$Execute, [string]$Arguments) { return [pscustomobject]@{ TaskName = 'ChartEngine Updater'; State = 'Ready'; Actions = @([pscustomobject]@{ Execute = $Execute; Arguments = $Arguments }) } }

Test 'Test-SamePath: the same path in either form; two different paths are not' {
  $d = Join-Path $tmpRoot 'same path dir'
  New-Item -ItemType Directory -Force -Path $d | Out-Null
  Assert (Test-SamePath $d ($d + [IO.Path]::DirectorySeparatorChar)) 'a trailing separator'
  Assert (-not (Test-SamePath $d (Join-Path $tmpRoot 'other dir'))) 'two paths'
  if ($IsWin) {
    $fso = New-Object -ComObject Scripting.FileSystemObject
    $short = $fso.GetFolder($d).ShortPath
    Assert (Test-SamePath $short $d) "8.3 $short and its long form"
  }
}

Test 'register keeps the current task''s -Repo (review B1): from its arguments, our launcher or a hand-made one; an explicit -Repo wins; anything else is refused by name' {
  $keepP = $script:P
  $mine = Join-Path $tmpRoot 'keep clone'
  $other = Join-Path $tmpRoot 'other clone'
  Initialize-Paths $mine (Join-Path (Join-Path $tmpRoot 'keep docs') 'NinjaTrader 8')
  try {
    $ps = Get-SystemExe 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $pinned = Join-Path $script:P.Bin 'update-pc.ps1'
    # 1. the task's own arguments (registered before the hidden start)
    $t = New-FakeTask $ps (Get-TaskArguments $pinned $other)
    $r = Resolve-TaskOptions $t @{}
    Assert ($r.error -match [regex]::Escape("the current task runs the clone $other") -and $r.error -match '-Repo') "refused, naming -Repo: $($r.error)"
    Assert (-not (Resolve-TaskOptions (New-FakeTask $ps (Get-TaskArguments $pinned $mine)) @{}).error) 'the same clone: kept, no question'
    # 2. our launcher
    $ours = Get-HiddenLauncherPath
    Write-HiddenLauncher $ours (Get-HiddenLauncherLine $ps (Get-TaskArguments $pinned $other))
    $r = Resolve-TaskOptions (New-FakeTask 'C:\Windows\System32\wscript.exe' ('//B "' + $ours + '"')) @{}
    Assert ($r.error -match [regex]::Escape($other) -and $r.error -match [regex]::Escape($ours)) "read from our launcher: $($r.error)"
    # 3. a hand-made launcher (C:\SchwabDesk_bulk\hidden form, with cmd /c cd /d)
    $handDir = Join-Path $tmpRoot 'hidden by hand'
    New-Item -ItemType Directory -Force -Path $handDir | Out-Null
    $hand = Join-Path $handDir 'chartengine_updater.vbs'
    $cmd = 'cmd /c cd /d ' + (Format-Arg $script:P.Bin) + ' && ' + (Format-Arg $ps) + ' ' + (Get-TaskArguments $pinned $other)
    [IO.File]::WriteAllText($hand, 'WScript.Quit CreateObject("WScript.Shell").Run("' + $cmd.Replace('"', '""') + '", 0, True)' + "`r`n", [Text.Encoding]::ASCII)
    $handTask = New-FakeTask 'C:\Windows\System32\wscript.exe' ('"' + $hand + '"')
    $r = Resolve-TaskOptions $handTask @{}
    Assert ($r.error -match [regex]::Escape("runs the clone $other") -and $r.error -match [regex]::Escape($hand)) "read from the hand-made launcher: $($r.error)"
    # 4. an explicit -Repo wins; an explicit empty one does not clear it
    $r = Resolve-TaskOptions $handTask @{ Repo = $mine }
    Assert (-not $r.error -and ($r.notes -join ' ') -match [regex]::Escape("the task had $other")) "explicit wins: $($r.error) $($r.notes -join ' ')"
    $r = Resolve-TaskOptions $handTask @{ Repo = '' }
    Assert ($r.error -match "-Repo '' would drop") "empty refused: $($r.error)"
    # 5. a launcher that is missing, or a task that runs something else: refused, naming why
    $r = Resolve-TaskOptions (New-FakeTask 'C:\Windows\System32\wscript.exe' ('//B "' + (Join-Path $handDir 'gone.vbs') + '"')) @{ Repo = $mine }
    Assert ($r.error -match 'cannot be read' -and $r.error -match 'gone\.vbs is missing') "missing: $($r.error)"
    $r = Resolve-TaskOptions (New-FakeTask $ps '-NoProfile -File C:\x\other.ps1 run') @{}
    Assert ($r.error -match 'does not run update-pc\.ps1') "something else: $($r.error)"
    Assert (-not (Resolve-TaskOptions $null @{}).error) 'no task: nothing to keep'
  } finally { $script:P = $keepP }
}

Test 'status checks the task''s start (review N1): ours exactly as register writes it, missing or changed is not ok, hand-made and visible starts are said' {
  $keepP = $script:P
  Initialize-Paths (Join-Path $tmpRoot 'status clone') (Join-Path (Join-Path $tmpRoot 'status docs') 'NinjaTrader 8')
  try {
    $ps = Get-SystemExe 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $pinned = Join-Path $script:P.Bin 'update-pc.ps1'
    $want = { param($o) Get-HiddenLauncherLine (Get-SystemExe 'System32\WindowsPowerShell\v1.0\powershell.exe') (Get-TaskArguments (Join-Path $script:P.Bin 'update-pc.ps1') ([string]$o['Repo'])) }
    $ours = Get-HiddenLauncherPath
    $task = New-FakeTask 'C:\Windows\System32\wscript.exe' ('//B "' + $ours + '"')
    $r = Test-TaskStart $task 'update-pc.ps1' $want
    Assert (-not $r.ok -and $r.text -match 'LAUNCHER MISSING' -and $r.text -match 'updates are not running') "missing: $($r.text)"
    Write-TaskLauncher $pinned
    $r = Test-TaskStart $task 'update-pc.ps1' $want
    Assert ($r.ok -and $r.text -match '^hidden \(wscript\.exe //B ' -and $r.line -ceq ('"' + $ps + '" ' + (Get-TaskArguments $pinned $script:P.Repo))) "ours: $($r.text) / $($r.line)"
    $line = [IO.File]::ReadAllText($ours)
    [IO.File]::WriteAllText($ours, $line.Replace(' update ', ' update  '), [Text.Encoding]::ASCII)
    $r = Test-TaskStart $task 'update-pc.ps1' $want
    Assert (-not $r.ok -and $r.text -match 'LAUNCHER CHANGED') "changed: $($r.text)"
    foreach ($bad in @(@(', 0, True)', ', 1, True)'), @(', 0, True)', ', 0, False)'))) {      # a window that shows, a run not waited for
      [IO.File]::WriteAllText($ours, $line.Replace($bad[0], $bad[1]), [Text.Encoding]::ASCII)
      $r = Test-TaskStart $task 'update-pc.ps1' $want
      Assert (-not $r.ok -and $r.text -match 'LAUNCHER CHANGED') "$($bad[1]): $($r.text)"
    }
    [IO.File]::WriteAllText($ours, $line.Replace('update-pc.ps1', 'other.ps1'), [Text.Encoding]::ASCII)
    $r = Test-TaskStart $task 'update-pc.ps1' $want
    Assert (-not $r.ok -and $r.text -match 'does not run update-pc\.ps1') "another script: $($r.text)"
    $r = Test-TaskStart (New-FakeTask $ps (Get-TaskArguments $pinned $script:P.Repo)) 'update-pc.ps1' $want
    Assert ($r.ok -and $r.text -match '^not hidden') "visible: $($r.text)"
    $hand = Join-Path $tmpRoot 'hand.vbs'
    [IO.File]::WriteAllText($hand, $line, [Text.Encoding]::ASCII)
    $r = Test-TaskStart (New-FakeTask 'C:\Windows\System32\wscript.exe' ('"' + $hand + '"')) 'update-pc.ps1' $want
    Assert ($r.ok -and $r.text -match 'register did not write') "hand-made: $($r.text)"
    Assert ((Format-Age (New-TimeSpan -Minutes 7)) -eq '7 min' -and (Format-Age (New-TimeSpan -Hours 2 -Minutes 5)) -eq '2 h 5 min' -and (Format-Age (New-TimeSpan -Days 3 -Hours 4)) -eq '3 d 4 h') 'the age of the last run'
  } finally { $script:P = $keepP }
}

Test '-InstallChartBridge moves a task that is not hidden to the launcher once, keeping -Repo; 17:05 becomes 09:00 and 17:00, another time is kept; a refusal or failure is said (stubbed)' {
  $keepP = $script:P; $keepOS = $env:OS
  Initialize-Paths (Join-Path $tmpRoot 'mig clone') (Join-Path (Join-Path $tmpRoot 'mig docs') 'NinjaTrader 8')
  . $script:TaskStubs
  function Get-CurrentUserName { return 'PC\anthony' }
  function Test-Elevated { return $script:Elevated }
  $script:Elevated = $false
  # a task as Get-ScheduledTask returns it, with the user it runs as
  function New-MigTask([string]$Execute, [string]$Arguments, [string]$User = 'PC\anthony', [string]$Logon = 'Interactive') {
    $t = New-FakeTask $Execute $Arguments
    $t | Add-Member -NotePropertyName Principal -NotePropertyValue ([pscustomobject]@{ UserId = $User; LogonType = $Logon })
    return $t
  }
  try {
    $env:OS = 'Windows_NT'
    $ps = Get-SystemExe 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $pinned = Join-Path $script:P.Bin 'update-pc.ps1'
    Put $pinned "# the pinned copy`n"
    $pj = Join-Path $script:P.Bin 'pinned.json'
    Write-JsonAtomic $pj @{ commit = 'abc'; dailyAt = '17:05'; repo = $script:P.Repo }
    $script:StubTask = New-MigTask $ps (Get-TaskArguments $pinned $script:P.Repo)
    $script:StubTask.State = 'Running'                     # a running task's action is changed all the same
    $lines = @(Invoke-TaskMigration)
    $launcher = Get-HiddenLauncherPath
    Assert ($lines[0] -eq "The scheduled task now starts hidden: wscript.exe //B $launcher (it was the task's action ($ps)).") "said: $($lines -join ' / ')"
    Assert ($lines[1] -eq "  kept: -Repo $($script:P.Repo) and the pinned copy $pinned; the triggers, user and settings are register's own (they replace the old ones)") "kept: $($lines[1])"
    Assert ($lines[2] -match 'daily checks: 09:00 and 17:00 New York time \(it was 17:05; Anthony 2026-10-23: twice a day') "09:00 and 17:00: $($lines[2])"
    $reg = @(Get-TaskCall 'register')
    Assert ($reg.Count -eq 1 -and $reg[0].Action.Arguments -ceq ('//B "' + $launcher + '"') -and $reg[0].Action.WorkingDirectory -eq $script:P.Bin) 'the task: wscript.exe //B on the launcher'
    $inv = [Globalization.CultureInfo]::InvariantCulture
    Assert ($reg[0].Trigger.Count -eq 3 -and $reg[0].Trigger[0].Kind -eq 'logon') "at sign-in and two daily: $($reg[0].Trigger.Count)"
    Assert ($reg[0].Trigger[1].StartBoundary -eq (ConvertFrom-NewYorkTime '09:00').ToString('yyyy-MM-ddTHH:mm:ss', $inv)) "daily at 09:00: $($reg[0].Trigger[1].StartBoundary)"
    Assert ($reg[0].Trigger[2].Kind -eq 'daily' -and $reg[0].Trigger[2].StartBoundary -eq (ConvertFrom-NewYorkTime '17:00').ToString('yyyy-MM-ddTHH:mm:ss', $inv)) "daily at 17:00: $($reg[0].Trigger[2].StartBoundary)"
    $now = Read-JsonFile $pj
    Assert ($now['dailyAt'] -eq '09:00' -and (@($now['dailyTimes']) -join ',') -eq '09:00,17:00') 'pinned.json follows'
    Assert ([IO.File]::ReadAllText($launcher) -ceq ((Get-HiddenLauncherLine $ps (Get-TaskArguments $pinned $script:P.Repo)) + "`r`n")) 'the launcher register writes'
    Assert (@(Invoke-TaskMigration).Count -eq 0 -and @(Get-TaskCall 'register').Count -eq 1) 'once: a task on its own launcher is left alone'
    Assert ((Get-Text $script:P.Log) -match 'the scheduled task moved to the hidden launcher by -InstallChartBridge; daily at 09:00 and 17:00 New York time \(it was 17:05\)') 'logged'
    # a hand-made launcher and another time: the time is kept
    $hand = Join-Path (Join-Path $tmpRoot 'mig hidden') 'chartengine_updater.vbs'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $hand) | Out-Null
    $c = (Format-Arg $ps) + ' ' + (Get-TaskArguments $pinned $script:P.Repo)
    [IO.File]::WriteAllText($hand, 'WScript.Quit CreateObject("WScript.Shell").Run("' + $c.Replace('"', '""') + '", 0, True)' + "`r`n", [Text.Encoding]::ASCII)
    Write-JsonAtomic $pj @{ commit = 'abc'; dailyAt = '08:30'; repo = $script:P.Repo }
    $script:StubTask = New-MigTask 'C:\Windows\System32\wscript.exe' ('"' + $hand + '"')
    $lines = @(Invoke-TaskMigration)
    Assert ($lines[2] -eq '  daily checks: 08:30 New York time' -and (Read-JsonFile $pj)['dailyAt'] -eq '08:30' -and (Test-Path -LiteralPath $hand)) "kept 08:30: $($lines -join ' / ')"
    Assert (@((Read-JsonFile $pj)['dailyTimes']).Count -eq 1 -and @(Get-TaskCall 'register')[-1].Trigger.Count -eq 2) 'one daily time, one daily trigger'
    # refused by name: the task runs another clone; nothing changed
    Write-JsonAtomic $pj @{ commit = 'abc'; dailyAt = '17:05'; repo = $script:P.Repo }
    $script:StubTask = New-MigTask $ps (Get-TaskArguments $pinned (Join-Path $tmpRoot 'other clone'))
    $n = @(Get-TaskCall 'register').Count
    $lines = @(Invoke-TaskMigration)
    Assert ($lines.Count -eq 1 -and $lines[0] -match 'was not moved to the hidden launcher: the current task runs the clone .*other clone' -and $lines[0] -match 'update-pc\.ps1 register moves it') "refused: $($lines -join ' / ')"
    Assert (@(Get-TaskCall 'register').Count -eq $n -and (Read-JsonFile $pj)['dailyAt'] -eq '17:05') 'nothing changed'
    # refused, said, nothing changed: an elevated window, another user, a script that is not the pinned copy
    $plain = (Get-TaskArguments $pinned $script:P.Repo)
    $n = @(Get-TaskCall 'register').Count
    Remove-Item -LiteralPath $launcher -Force
    $script:Elevated = $true
    $script:StubTask = New-MigTask $ps $plain
    $lines = @(Invoke-TaskMigration)
    Assert ($lines[0] -match 'not moved to the hidden launcher: this window is elevated') "elevated: $($lines -join ' / ')"
    $script:Elevated = $false
    $script:StubTask = New-MigTask $ps $plain 'PC\someone'
    $lines = @(Invoke-TaskMigration)
    Assert ($lines[0] -match [regex]::Escape('not moved to the hidden launcher: the task runs as PC\someone, this window is PC\anthony')) "another user: $($lines -join ' / ')"
    $script:StubTask = New-MigTask $ps ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + (Format-Arg (Join-Path $tmpRoot 'elsewhere\update-pc.ps1')) + ' update -Repo ' + (Format-Arg $script:P.Repo))
    $lines = @(Invoke-TaskMigration)
    Assert ($lines[0] -match 'not moved to the hidden launcher: the task runs .*elsewhere.update-pc\.ps1, not the pinned copy') "another script: $($lines -join ' / ')"
    Assert (@(Get-TaskCall 'register').Count -eq $n -and -not (Test-Path -LiteralPath $launcher) -and (Read-JsonFile $pj)['dailyAt'] -eq '17:05') 'refused: nothing changed'
    Assert ((Test-SameUser 'anthony' 'PC\anthony') -and (Test-SameUser 'PC\anthony' 'pc\Anthony') -and -not (Test-SameUser 'PC\anthony' 'WORK\anthony') -and -not (Test-SameUser '' 'PC\anthony')) 'user forms'
    # a failure is said, never throws, and changes nothing: pinned.json stays 17:05, no launcher left behind
    function Register-ScheduledTask { throw 'Access is denied' }
    $script:StubTask = New-MigTask $ps $plain
    $lines = @(Invoke-TaskMigration)
    Assert ($lines[0] -match 'was not moved to the hidden launcher: Access is denied') "failure: $($lines -join ' / ')"
    Assert ((Read-JsonFile $pj)['dailyAt'] -eq '17:05') 'pinned.json still 17:05'
    Assert (-not (Test-Path -LiteralPath $launcher)) 'no stray launcher'
    # and a launcher that was there before is put back as it was
    [IO.File]::WriteAllText($launcher, "an older line`r`n", [Text.Encoding]::ASCII)
    $lines = @(Invoke-TaskMigration)
    Assert ([IO.File]::ReadAllText($launcher) -ceq "an older line`r`n") 'the launcher as it was'
    # the automatic run only warns, and changes nothing
    $before = (Get-Text $script:P.Log)
    Write-TaskStartWarning
    $after = (Get-Text $script:P.Log)
    Assert ($after.Substring($before.Length) -match 'WARN the task still starts without the hidden launcher: it is migrated at the next -InstallChartBridge \(unless it is refused there; see its output\) or update-pc\.ps1 register') 'the warning'
    $script:StubTask = New-FakeTask 'C:\Windows\System32\wscript.exe' ('//B "' + $launcher + '"')
    Write-TaskStartWarning
    Assert ((Get-Text $script:P.Log) -eq $after) 'a hidden task: no warning'
  } finally { $env:OS = $keepOS; $script:P = $keepP }
}

Test 'the automatic run adds the 17:00 check to its own hidden task (the schedule only); refused by name otherwise; moves and leaves as before; status lines (stubbed)' {
  $keepP = $script:P; $keepOS = $env:OS; $keepSelf = $script:UpdaterSelf
  Initialize-Paths (Join-Path $tmpRoot 'add clone') (Join-Path (Join-Path $tmpRoot 'add docs') 'NinjaTrader 8')
  . $script:TaskStubs
  $script:Sets = New-Object System.Collections.ArrayList
  function Set-ScheduledTask { param([string]$TaskName, $Trigger) [void]$script:Sets.Add((@(@($Trigger) | ForEach-Object { "$($_.Kind):$($_.StartBoundary)" }) -join '|')) }
  function Get-CurrentUserName { return 'PC\anthony' }
  function Test-Elevated { return $script:Elevated }
  $script:Elevated = $false
  $inv = [Globalization.CultureInfo]::InvariantCulture
  function L([string]$Ny) { return (ConvertFrom-NewYorkTime $Ny).ToString('yyyy-MM-ddTHH:mm:ss', $inv) }
  function New-DailyStub([string]$Sb) { return [pscustomobject]@{ CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskDailyTrigger' }; StartBoundary = $Sb; Kind = 'daily' } }
  $logonT = [pscustomobject]@{ CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' }; StartBoundary = ''; Kind = 'logon' }
  # a task as Get-ScheduledTask returns it: its action, user and triggers (the sign-in one first)
  function Set-Stub([string]$Execute, [string]$Arguments, [object[]]$Daily, [string]$User = 'PC\anthony', [string]$Logon = 'Interactive') {
    $script:StubTask = [pscustomobject]@{ TaskName = 'ChartEngine Updater'; State = 'Ready'; Actions = @([pscustomobject]@{ Execute = $Execute; Arguments = $Arguments })
      Principal = [pscustomobject]@{ UserId = $User; LogonType = $Logon }; Triggers = @(@($logonT) + @($Daily)) }
  }
  try {
    $env:OS = 'Windows_NT'
    $pinned = Join-Path $script:P.Bin 'update-pc.ps1'
    Put $pinned "# the pinned copy`n"
    $pj = Join-Path $script:P.Bin 'pinned.json'
    Write-JsonAtomic $pj @{ commit = 'abc'; dailyAt = '09:00'; repo = $script:P.Repo }      # as a copy older than this change wrote it
    $pinText = Get-Text $pj
    Write-TaskLauncher $pinned
    $launcher = Get-HiddenLauncherPath
    $launcherText = Get-Text $launcher
    $wscript = Get-SystemExe 'System32\wscript.exe'
    $hidden = '//B "' + $launcher + '"'
    $ps = Get-SystemExe 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $script:UpdaterSelf = $pinned                  # the task's own run: the pinned copy
    # 1. one daily trigger (09:00, as register made it before this change): the 17:00 one is added, the rest kept
    Set-Stub $wscript $hidden @(New-DailyStub (L '09:00'))
    $res = Sync-DailyTrigger
    Assert ($script:Sets.Count -eq 1) "one Set-ScheduledTask: $($script:Sets.Count)"
    Assert ($script:Sets[0] -eq ('logon:|daily:' + (L '09:00') + '|daily:' + (L '17:00'))) "the sign-in trigger kept, 09:00 and 17:00 (wall-clock): $($script:Sets[0])"
    Assert ($res.ok -and -not $res.note -and $res.have -eq $res.want) "recorded: ok $($res.ok), note '$($res.note)'"
    Assert ((Get-Text $script:P.Log) -match 'the daily check at 17:00 New York time was added to the task') 'logged'
    Assert (@(Get-TaskCall 'register').Count -eq 0 -and @(Get-TaskCall 'action').Count -eq 0) 'the action is never touched: no register, no new action'
    Assert ((Get-Text $launcher) -ceq $launcherText -and (Get-Text $pj) -ceq $pinText) 'the launcher and pinned.json as they were'
    # 2. refused by name, nothing changed, the reason recorded for status
    $cases = @(
      @{ why = 'does not start through its own hidden launcher yet: -InstallChartBridge or update-pc.ps1 register moves it'; set = { Set-Stub $ps (Get-TaskArguments $pinned $script:P.Repo) @(New-DailyStub (L '09:00')) } },
      @{ why = 'this run is elevated'; set = { $script:Elevated = $true; Set-Stub $wscript $hidden @(New-DailyStub (L '09:00')) } },
      @{ why = 'the task runs as PC\\someone, this run as PC\\anthony'; set = { $script:Elevated = $false; Set-Stub $wscript $hidden @(New-DailyStub (L '09:00')) 'PC\someone' } },
      @{ why = 'not the task.s pinned copy'; set = { $script:UpdaterSelf = $keepSelf; Set-Stub $wscript $hidden @(New-DailyStub (L '09:00')) } })
    foreach ($c in $cases) {
      $script:Sets.Clear()
      & $c.set
      $res = Sync-DailyTrigger
      Assert ($script:Sets.Count -eq 0) "nothing changed: $($c.why)"
      Assert ($res.ok -and $res.note -match ('the daily check at 17:00 New York time was not added: .*' + $c.why)) "said: $($res.note)"
      $s = @{}; Save-TriggerCheck $s $res
      Assert ($s['dailyTrigger']['note'] -eq $res.note) 'state.json keeps the reason'
    }
    $script:UpdaterSelf = $pinned
    # 3. both there: nothing to do
    $script:Sets.Clear()
    Set-Stub $wscript $hidden @((New-DailyStub (L '09:00')), (New-DailyStub (L '17:00')))
    $res = Sync-DailyTrigger
    Assert ($script:Sets.Count -eq 0 -and $res.ok -and -not $res.note) 'both there: nothing'
    # 4. both drifted (or kept on UTC): a run by hand (not the pinned copy) changes no trigger and says so (Anthony
    # 2026-10-23: every trigger change only in the task's own run); the task's own run moves them back
    $script:UpdaterSelf = $keepSelf
    Set-Stub $wscript $hidden @((New-DailyStub '2026-01-01T03:00:00'), (New-DailyStub ((L '17:00') + '-04:00')))
    $res = Sync-DailyTrigger
    Assert ($script:Sets.Count -eq 0 -and $res.note -match 'the daily checks were not moved .*not the task.s pinned copy .*the clone.s copy') "a run of the clone's copy: $($res.note)"
    Assert ((Get-Text $script:P.Log) -match 'WARN the daily checks were not moved') 'said in update.log'
    foreach ($c in @(@{ set = { $script:Elevated = $true }; why = 'this run is elevated' }, @{ set = { $script:Elevated = $false; $script:StubTask.Principal = [pscustomobject]@{ UserId = 'PC\someone'; LogonType = 'Interactive' } }; why = 'the task runs as PC\\someone' },
        @{ set = { $script:StubTask.Principal = [pscustomobject]@{ UserId = 'PC\anthony'; LogonType = 'S4U' } }; why = 'the task runs with logon type S4U, not Interactive \(only while signed in\)' })) {
      $script:UpdaterSelf = $pinned
      Set-Stub $wscript $hidden @((New-DailyStub '2026-01-01T03:00:00'), (New-DailyStub ((L '17:00') + '-04:00')))
      & $c.set
      $res = Sync-DailyTrigger
      Assert ($script:Sets.Count -eq 0 -and $res.note -match ('not moved .*' + $c.why)) "refused: $($res.note)"
    }
    $script:Elevated = $false
    $script:UpdaterSelf = $pinned
    Set-Stub $wscript $hidden @((New-DailyStub '2026-01-01T03:00:00'), (New-DailyStub ((L '17:00') + '-04:00')))
    $res = Sync-DailyTrigger
    Assert ($script:Sets.Count -eq 1 -and $script:Sets[0] -eq ('logon:|daily:' + (L '09:00') + '|daily:' + (L '17:00'))) "moved: $($script:Sets -join ' / ')"
    Assert ((Get-Text $script:P.Log) -match 'the daily check moved from .*03:00.* to .* \(09:00 and 17:00 New York time\) \(it was kept on UTC') 'logged, with why'
    # 5. more daily triggers than times, or none: left to register, said
    $script:Sets.Clear()
    Set-Stub $wscript $hidden @((New-DailyStub (L '09:00')), (New-DailyStub (L '17:00')), (New-DailyStub '2026-01-01T12:00:00'))
    $res = Sync-DailyTrigger
    Assert ($script:Sets.Count -eq 0 -and $res.note -match 'the task has 3 daily triggers .*more than the daily times \(09:00 and 17:00 New York time\); register sets them') "left: $($res.note)"
    Set-Stub $wscript $hidden @()
    $res = Sync-DailyTrigger
    Assert ($script:Sets.Count -eq 0 -and $res.note -match 'no daily trigger') "none: $($res.note)"
    # 6. a pin of this version with one time (given by hand): one trigger is right, nothing added
    $script:UpdaterSelf = $pinned
    $pin = Read-JsonFile $pj; Set-PinTimes $pin '09:00'; Write-JsonAtomic $pj $pin
    Set-Stub $wscript $hidden @(New-DailyStub (L '09:00'))
    $res = Sync-DailyTrigger
    Assert ($script:Sets.Count -eq 0 -and -not $res.note) 'one time by hand: nothing added'
    Write-JsonAtomic $pj @{ commit = 'abc'; dailyAt = '09:00'; repo = $script:P.Repo }
    # 7. Task Scheduler refuses (a task registered from an elevated window): recorded, nothing else changed
    function Set-ScheduledTask { throw 'Access is denied.' }
    $res = Sync-DailyTrigger
    Assert (-not $res.ok -and $res.error -match 'Access is denied') "failure recorded: $($res.error)"
    # status: both times, their clock time and next run; a missing one and a stray one said
    $now = [datetime]'2026-10-23 12:00'
    $l9 = (ConvertFrom-NewYorkTime '09:00' $now).ToString('HH:mm', $inv); $l17 = (ConvertFrom-NewYorkTime '17:00' $now).ToString('HH:mm', $inv)
    Set-Stub $wscript $hidden @((New-DailyStub (L '09:00')), (New-DailyStub (L '17:00')))
    $lines = @(Get-DailyLines $script:StubTask @('09:00', '17:00') $now)
    Assert ($lines.Count -eq 2 -and $lines[0] -eq "09:00 New York time, $l9 on this PC's clock, next run $(Get-NextDailyRun $l9 $now)" -and $lines[1] -eq "17:00 New York time, $l17 on this PC's clock, next run $(Get-NextDailyRun $l17 $now)") "lines: $($lines -join ' / ')"
    Assert ((Get-NextDailyRun '09:00' $now) -eq '2026-10-24 09:00' -and (Get-NextDailyRun '17:00' $now) -eq '2026-10-23 17:00') 'the next run: later today, or tomorrow'
    Set-Stub $wscript $hidden @((New-DailyStub (L '09:00')), (New-DailyStub '2026-01-01T03:00:00'))
    $lines = @(Get-DailyLines $script:StubTask @('09:00', '17:00') $now)
    Assert ($lines.Count -eq 3 -and $lines[1] -match '^17:00 New York time, .*NO TRIGGER at that time yet' -and $lines[2] -match 'a daily trigger at 03:00 .*DRIFTED, the next run moves it') "lines: $($lines -join ' / ')"
    # register: one daily trigger per time
    Register-HiddenTask 'PC\anthony' $pinned @(Get-DailyLocal @('09:00', '17:00'))
    $reg = @(Get-TaskCall 'register')[-1]
    Assert ($reg.Trigger.Count -eq 3 -and $reg.Trigger[0].Kind -eq 'logon' -and $reg.Trigger[1].StartBoundary -eq (L '09:00') -and $reg.Trigger[2].StartBoundary -eq (L '17:00')) "register: sign-in, 09:00, 17:00: $(@($reg.Trigger | ForEach-Object { $_.StartBoundary }) -join ',')"
  } finally { $env:OS = $keepOS; $script:P = $keepP; $script:UpdaterSelf = $keepSelf }
}

Test 'WORK''s hand-made launcher (cmd /s /c, 2026-10-22) is read; the task''s own run moves it to its own launcher with 09:00 and 17:00, as -InstallChartBridge does; refused by name otherwise (stubbed)' {
  # WORK's real line, as FROM_WORK_2026-10-23_release_068 gave it (the user's name left out). cmd's /c is joined from two
  # parts only so the command-string guard (test/pc-updater.test.js, PowerShell's -c) does not read it as PowerShell's
  $workLine = 'WScript.Quit CreateObject("WScript.Shell").Run("cmd /s /' + 'c ""cd /d ""C:\Users\<user>\Documents\NinjaTrader 8\ChartBridge\updater\bin"" && ""C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""C:\Users\<user>\Documents\NinjaTrader 8\ChartBridge\updater\bin\update-pc.ps1"" update -Repo C:\TheDesk\chart-engine""", 0, True)'
  $wf = Join-Path $tmpRoot 'work-real.vbs'
  [IO.File]::WriteAllText($wf, $workLine + "`r`n", [Text.Encoding]::ASCII)
  $line = Get-LauncherCommand $wf
  Assert ($line -ceq '"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Users\<user>\Documents\NinjaTrader 8\ChartBridge\updater\bin\update-pc.ps1" update -Repo C:\TheDesk\chart-engine') "the command: $line"
  $o = Get-CommandOptions $line 'update-pc.ps1'
  Assert ($null -ne $o -and $o['#script'] -eq 'C:\Users\<user>\Documents\NinjaTrader 8\ChartBridge\updater\bin\update-pc.ps1' -and $o['#command'] -eq 'update' -and $o['Repo'] -eq 'C:\TheDesk\chart-engine') 'its script, command and -Repo'
  Assert (@($o.Keys | Where-Object { $_ -notlike '#*' }).Count -eq 1) "nothing else: $(@($o.Keys) -join ',')"
  # the older form still reads: cmd /c cd /d <folder> && <command>
  [IO.File]::WriteAllText($wf, 'WScript.Quit CreateObject("WScript.Shell").Run("cmd /' + 'c cd /d C:\x && ""C:\p s\powershell.exe"" -File C:\b\update-pc.ps1 update -Repo C:\r", 0, True)' + "`r`n", [Text.Encoding]::ASCII)
  Assert ((Get-LauncherCommand $wf) -ceq '"C:\p s\powershell.exe" -File C:\b\update-pc.ps1 update -Repo C:\r') "cmd /c: $(Get-LauncherCommand $wf)"

  $keepP = $script:P; $keepOS = $env:OS; $keepSelf = $script:UpdaterSelf; $keepHand = $script:HandLauncherDir
  Initialize-Paths (Join-Path $tmpRoot 'work clone') (Join-Path (Join-Path $tmpRoot 'work docs') 'NinjaTrader 8')
  . $script:TaskStubs
  function Get-CurrentUserName { return 'PC\anthony' }
  function Test-Elevated { return $script:Elevated }
  $script:Elevated = $false
  $inv = [Globalization.CultureInfo]::InvariantCulture
  $handDir = Join-Path $tmpRoot 'SchwabDesk_bulk hidden'
  New-Item -ItemType Directory -Force -Path $handDir | Out-Null
  $script:HandLauncherDir = $handDir
  $hand = Join-Path $handDir 'ChartEngine_Updater.vbs'
  $pinned = Join-Path $script:P.Bin 'update-pc.ps1'
  # WORK's line with this test's folders in place of WORK's (the same form: cmd /s /c, quotes doubled, no //B)
  function Write-Hand([string]$Tail = '') {
    $l = $workLine.Replace('C:\Users\<user>\Documents\NinjaTrader 8\ChartBridge\updater\bin', $script:P.Bin).Replace('C:\TheDesk\chart-engine', (Format-Arg $script:P.Repo).Replace('"', '""') + $Tail)
    [IO.File]::WriteAllText($hand, $l + "`r`n", [Text.Encoding]::ASCII)
  }
  function Set-Hand([string]$User = 'PC\anthony', [string]$Launcher = $hand, [string]$Logon = 'Interactive') {
    $script:StubTask = [pscustomobject]@{ TaskName = 'ChartEngine Updater'; State = 'Running'
      Actions = @([pscustomobject]@{ Execute = 'C:\WINDOWS\system32\wscript.exe'; Arguments = '"' + $Launcher + '"' })
      Principal = [pscustomobject]@{ UserId = $User; LogonType = $Logon }; Triggers = @() }
  }
  try {
    $env:OS = 'Windows_NT'
    Put $pinned "# the pinned copy`n"
    Put $script:P.Log ""
    $pj = Join-Path $script:P.Bin 'pinned.json'
    Write-JsonAtomic $pj @{ commit = 'abc'; dailyAt = '17:05'; repo = $script:P.Repo }     # as WORK's older copy wrote it
    $pinText = Get-Text $pj
    Write-Hand
    $handText = Get-Text $hand
    $launcher = Get-HiddenLauncherPath
    $ps = Get-SystemExe 'System32\WindowsPowerShell\v1.0\powershell.exe'
    # a run by hand from the clone: nothing (the task's own run does it)
    $script:UpdaterSelf = $keepSelf
    Set-Hand
    Assert ((Invoke-AutoTaskMigration) -eq '' -and @(Get-TaskCall 'register').Count -eq 0) 'a run that is not the pinned copy: nothing'
    $script:UpdaterSelf = $pinned
    # refused by name, one WARN line, nothing changed: elevated, another user, an option the launcher does not carry
    $n = 0
    foreach ($c in @(@{ set = { $script:Elevated = $true; Set-Hand }; why = 'this window is elevated' },
        @{ set = { $script:Elevated = $false; Set-Hand 'PC\someone' }; why = 'the task runs as PC\\someone' },
        @{ set = { Set-Hand 'PC\anthony' $hand 'S4U' }; why = 'the task runs with logon type S4U, not Interactive \(only while signed in\)' },
        @{ set = { Set-Hand 'PC\anthony' $hand '' }; why = 'the task.s logon type cannot be read' },
        @{ set = { Write-Hand ' -TaskName X'; Set-Hand }; why = 'the task runs with -TaskName X, which the launcher does not carry' })) {
      & $c.set
      $before = Get-Text $script:P.Log
      $said = Invoke-AutoTaskMigration
      $new = (Get-Text $script:P.Log).Substring($before.Length)
      Assert ($said -match ('the scheduled task was not moved to the hidden launcher: .*' + $c.why)) "refused: $said"
      Assert (@($new.Split("`n") | Where-Object { $_ -match ' WARN ' }).Count -eq 1) "one WARN line: $new"
      Assert (@(Get-TaskCall 'register').Count -eq 0 -and -not (Test-Path -LiteralPath $launcher) -and (Get-Text $pj) -ceq $pinText) 'nothing changed'
    }
    Write-Hand
    # a launcher elsewhere, or a plain powershell.exe task: left to -InstallChartBridge or register
    $other = Join-Path $tmpRoot 'elsewhere.vbs'; Copy-Item -LiteralPath $hand -Destination $other
    Set-Hand 'PC\anthony' $other
    Assert ((Invoke-AutoTaskMigration) -eq '') 'a .vbs outside C:\SchwabDesk_bulk\hidden: not this move'
    $script:StubTask = New-FakeTask $ps (Get-TaskArguments $pinned $script:P.Repo)
    Assert ((Invoke-AutoTaskMigration) -eq '') 'plain powershell.exe: not this move'
    # Task Scheduler refuses: nothing changed, the hand-made launcher kept
    function Register-ScheduledTask { throw 'Access is denied' }
    Set-Hand
    $said = Invoke-AutoTaskMigration
    Assert ($said -match 'not moved to the hidden launcher: Access is denied' -and -not (Test-Path -LiteralPath $launcher) -and (Get-Text $pj) -ceq $pinText) "failure: $said"
    . $script:TaskStubs
    function Get-CurrentUserName { return 'PC\anthony' }
    # the task's own run (the pinned copy, not elevated, its own user): moved, -Repo kept, 09:00 and 17:00 plus sign-in
    Set-Hand
    $said = Invoke-AutoTaskMigration
    $reg = @(Get-TaskCall 'register')
    Assert ($reg.Count -eq 1 -and $reg[0].Action.Arguments -ceq ('//B "' + $launcher + '"')) "moved: $said"
    Assert ([IO.File]::ReadAllText($launcher) -ceq ((Get-HiddenLauncherLine $ps (Get-TaskArguments $pinned $script:P.Repo)) + "`r`n")) 'the launcher register writes, -Repo kept'
    Assert ($reg[0].Trigger.Count -eq 3 -and $reg[0].Trigger[0].Kind -eq 'logon' -and $reg[0].Trigger[1].StartBoundary -eq (ConvertFrom-NewYorkTime '09:00').ToString('yyyy-MM-ddTHH:mm:ss', $inv) -and $reg[0].Trigger[2].StartBoundary -eq (ConvertFrom-NewYorkTime '17:00').ToString('yyyy-MM-ddTHH:mm:ss', $inv)) 'sign-in, 09:00 and 17:00'
    Assert ((@((Read-JsonFile $pj)['dailyTimes']) -join ',') -eq '09:00,17:00') 'pinned.json follows'
    Assert ((Test-Path -LiteralPath $hand) -and (Get-Text $hand) -ceq $handText) 'the hand-made .vbs left on disk as it was'
    Assert ((Get-Text $script:P.Log) -match "the scheduled task moved to the hidden launcher by the task's own run; daily at 09:00 and 17:00 New York time \(it was 17:05\)") 'logged'
    Assert ((Invoke-AutoTaskMigration) -eq '' -and @(Get-TaskCall 'register').Count -eq 1) 'once: then on its own launcher'
    # -InstallChartBridge moves the same task the same way (it said "does not run update-pc.ps1" before this change)
    Write-JsonAtomic $pj @{ commit = 'abc'; dailyAt = '17:05'; repo = $script:P.Repo }
    Set-Hand
    $lines = @(Invoke-TaskMigration)
    Assert ($lines[0] -match '^The scheduled task now starts hidden' -and @(Get-TaskCall 'register').Count -eq 2) "-InstallChartBridge: $($lines -join ' / ')"
  } finally { $env:OS = $keepOS; $script:P = $keepP; $script:UpdaterSelf = $keepSelf; $script:HandLauncherDir = $keepHand }
}

Test 'HOME''s hand-made launcher (cmd /c without /s, 2026-10-22) is read, and the task''s own run moves it with 09:00 and 17:00 (stubbed)' {
  # HOME's real line (FROM_HOME_2026-10-22_hidden_tasks), the user's name left out; cmd's /c joined from two parts only
  # so the command-string guard (test/pc-updater.test.js, PowerShell's -c) does not read it as PowerShell's
  $homeLine = 'WScript.Quit CreateObject("WScript.Shell").Run("cmd /' + 'c ""cd /d ""C:\Users\<user>\Documents\NinjaTrader 8\ChartBridge\updater\bin"" && ""C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""C:\Users\<user>\Documents\NinjaTrader 8\ChartBridge\updater\bin\update-pc.ps1"" update -Repo C:\Users\<user>\chart-engine""", 0, True)'
  $hf = Join-Path $tmpRoot 'home-real.vbs'
  [IO.File]::WriteAllText($hf, $homeLine + "`r`n", [Text.Encoding]::ASCII)
  $line = Get-LauncherCommand $hf
  Assert ($line -ceq '"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Users\<user>\Documents\NinjaTrader 8\ChartBridge\updater\bin\update-pc.ps1" update -Repo C:\Users\<user>\chart-engine') "the command: $line"
  $o = Get-CommandOptions $line 'update-pc.ps1'
  Assert ($null -ne $o -and $o['#script'] -eq 'C:\Users\<user>\Documents\NinjaTrader 8\ChartBridge\updater\bin\update-pc.ps1' -and $o['#command'] -eq 'update' -and $o['Repo'] -eq 'C:\Users\<user>\chart-engine' -and @($o.Keys | Where-Object { $_ -notlike '#*' }).Count -eq 1) 'its script, command and -Repo, nothing else'

  $keepP = $script:P; $keepOS = $env:OS; $keepSelf = $script:UpdaterSelf; $keepHand = $script:HandLauncherDir
  Initialize-Paths (Join-Path $tmpRoot 'home clone') (Join-Path (Join-Path $tmpRoot 'home docs') 'NinjaTrader 8')
  . $script:TaskStubs
  function Get-CurrentUserName { return 'PC\anthony' }
  function Test-Elevated { return $false }
  $inv = [Globalization.CultureInfo]::InvariantCulture
  $handDir = Join-Path $tmpRoot 'home hidden'
  New-Item -ItemType Directory -Force -Path $handDir | Out-Null
  $script:HandLauncherDir = $handDir
  $hand = Join-Path $handDir 'ChartEngine_Updater.vbs'
  $pinned = Join-Path $script:P.Bin 'update-pc.ps1'
  try {
    $env:OS = 'Windows_NT'
    Put $pinned "# the pinned copy`n"
    Put $script:P.Log ''
    $pj = Join-Path $script:P.Bin 'pinned.json'
    Write-JsonAtomic $pj @{ commit = 'abc'; dailyAt = '17:05'; repo = $script:P.Repo }
    # HOME's line with this test's folders in place of HOME's (the same form: cmd /c, quotes doubled)
    $l = $homeLine.Replace('C:\Users\<user>\Documents\NinjaTrader 8\ChartBridge\updater\bin', $script:P.Bin).Replace('C:\Users\<user>\chart-engine', (Format-Arg $script:P.Repo).Replace('"', '""'))
    [IO.File]::WriteAllText($hand, $l + "`r`n", [Text.Encoding]::ASCII)
    $script:StubTask = [pscustomobject]@{ TaskName = 'ChartEngine Updater'; State = 'Ready'
      Actions = @([pscustomobject]@{ Execute = 'C:\WINDOWS\system32\wscript.exe'; Arguments = '"' + $hand + '"' })
      Principal = [pscustomobject]@{ UserId = 'PC\anthony'; LogonType = 'Interactive' }; Triggers = @() }
    $script:UpdaterSelf = $pinned
    $said = Invoke-AutoTaskMigration
    $reg = @(Get-TaskCall 'register')
    $launcher = Get-HiddenLauncherPath
    $ps = Get-SystemExe 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Assert ($reg.Count -eq 1 -and $reg[0].Action.Arguments -ceq ('//B "' + $launcher + '"')) "moved: $said"
    Assert ([IO.File]::ReadAllText($launcher) -ceq ((Get-HiddenLauncherLine $ps (Get-TaskArguments $pinned $script:P.Repo)) + "`r`n")) '-Repo kept'
    Assert ($reg[0].Trigger.Count -eq 3 -and $reg[0].Trigger[1].StartBoundary -eq (ConvertFrom-NewYorkTime '09:00').ToString('yyyy-MM-ddTHH:mm:ss', $inv) -and $reg[0].Trigger[2].StartBoundary -eq (ConvertFrom-NewYorkTime '17:00').ToString('yyyy-MM-ddTHH:mm:ss', $inv)) 'sign-in, 09:00 and 17:00'
    Assert (Test-Path -LiteralPath $hand) 'the hand-made .vbs left on disk'
  } finally { $env:OS = $keepOS; $script:P = $keepP; $script:UpdaterSelf = $keepSelf; $script:HandLauncherDir = $keepHand }
}

Test 'no task stub is left behind: the Windows-only register tests below get the real ScheduledTasks commands' {
  foreach ($n in @('New-ScheduledTaskAction', 'New-ScheduledTaskTrigger', 'New-ScheduledTaskPrincipal', 'New-ScheduledTaskSettingsSet', 'Register-ScheduledTask', 'Get-ScheduledTask', 'Unregister-ScheduledTask', 'Set-ScheduledTask')) {
    $c = Get-Command $n -ErrorAction SilentlyContinue
    if ($IsWin) { Assert ($c -and "$($c.ModuleName)" -eq 'ScheduledTasks') "$n is the ScheduledTasks module's: $(if ($c) { "$($c.CommandType) '$($c.ModuleName)'" } else { 'missing' })" }
    else { Assert (-not $c) "$n is not defined off Windows (a stub left behind): $(if ($c) { $c.CommandType })" }
  }
}

if ($IsWin) {
  Test 'the launcher register writes runs for real: wscript.exe //B starts it hidden, waits, and gives back its exit code (review gap)' {
    $keepP = $script:P
    $root = Join-Path $tmpRoot 'probe dir with spaces'
    Initialize-Paths (Join-Path $root 'my clone') (Join-Path (Join-Path $root 'Documents') 'NinjaTrader 8')
    . $script:TaskStubs
    try {
      $marker = Join-Path $root 'probe marker.txt'
      $probe = Join-Path $script:P.Bin 'update-pc.ps1'      # a harmless stand-in at the pinned copy's place
      Put $probe ("param([Parameter(Position = 0)][string]`$Command, [string]`$Repo)`r`n[IO.File]::WriteAllText('" + $marker.Replace("'", "''") + "', `$Command + '|' + `$Repo)`r`nexit 7`r`n")
      Register-HiddenTask 'PC\anthony' $probe (Get-Date)
      $reg = @(Get-TaskCall 'register')[0]
      Assert ($reg.Action.Arguments -ceq ('//B "' + (Get-HiddenLauncherPath) + '"')) "the action: $($reg.Action.Arguments)"
      $args2 = @(Split-CommandLine $reg.Action.Arguments)
      $r = Invoke-Native $reg.Action.Execute $args2 120
      Assert ($r.code -eq 7) "wscript.exe gave back the exit code 7: $($r.code) $($r.err)"
      Assert ((Test-Path -LiteralPath $marker) -and (Get-Text $marker) -ceq ('update|' + $script:P.Repo)) "the probe ran with its arguments: $(if (Test-Path -LiteralPath $marker) { Get-Text $marker })"
    } finally {
      $script:P = $keepP
      Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  Test '-InstallChartBridge migration on a real throwaway task: its old powershell.exe action becomes wscript.exe //B on the launcher' {
    $keepP = $script:P; $keepName = $script:TaskName
    $script:TaskName = 'ChartEngine Updater MIG ' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $TaskName = $script:TaskName
    Initialize-Paths (Join-Path $tmpRoot 'mig real clone') (Join-Path (Join-Path $tmpRoot 'mig real docs') 'NinjaTrader 8')
    function Test-Elevated { return $false }      # the CI runner is an administrator; the move refuses an elevated window
    try {
      $pinned = Join-Path $script:P.Bin 'update-pc.ps1'
      Put $pinned "# the pinned copy`n"
      Write-JsonAtomic (Join-Path $script:P.Bin 'pinned.json') @{ commit = 'abc'; dailyAt = '17:05'; repo = $script:P.Repo }
      $u = Get-CurrentUserName
      $old = New-ScheduledTaskAction -Execute (Get-SystemExe 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument (Get-TaskArguments $pinned $script:P.Repo) -WorkingDirectory $script:P.Bin
      Register-ScheduledTask -TaskName $TaskName -Action $old -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $u) -Principal (New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited) -Force | Out-Null
      $lines = @(Invoke-TaskMigration)
      $t = Get-ScheduledTask -TaskName $TaskName
      $a = @($t.Actions)[0]
      Assert ($a.Execute -match 'System32\\wscript\.exe$' -and $a.Arguments -eq ('//B "' + (Get-HiddenLauncherPath) + '"')) "migrated: $($a.Execute) $($a.Arguments) / $($lines -join ' / ')"
      $st = Test-TaskStart $t 'update-pc.ps1' { param($o) Get-HiddenLauncherLine (Get-SystemExe 'System32\WindowsPowerShell\v1.0\powershell.exe') (Get-TaskArguments (Join-Path $script:P.Bin 'update-pc.ps1') ([string]$o['Repo'])) }
      Assert $st.ok "status: $($st.text)"
      Assert (@(Invoke-TaskMigration).Count -eq 0) 'once'
    } finally {
      if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
      Remove-Item -LiteralPath (Join-Path $script:P.Bin 'update-pc.hidden.vbs') -Force -ErrorAction SilentlyContinue
      $script:P = $keepP; $script:TaskName = $keepName
    }
  }
  Test 'register: a task for this user, at sign-in and daily at 09:00 and 17:00 New York time, started hidden, IgnoreNew, -File, no admin' {
    $script:TaskName = 'ChartEngine Updater CI ' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $TaskName = $script:TaskName
    try {
      Assert-Code (Invoke-Register) 0 'register OK'
      $t = Get-ScheduledTask -TaskName $TaskName
      Assert ($t.Settings.MultipleInstances -eq 'IgnoreNew') "MultipleInstances $($t.Settings.MultipleInstances)"
      Assert ("$($t.Principal.LogonType)" -eq 'Interactive' -and "$($t.Principal.RunLevel)" -eq 'Limited') "principal $($t.Principal.LogonType) $($t.Principal.RunLevel)"
      $a = $t.Actions[0]
      $launcher = Join-Path $script:P.Bin 'update-pc.hidden.vbs'
      Assert ($a.Execute -match 'System32\\wscript\.exe$' -and $a.Arguments -eq ('//B "' + $launcher + '"')) "hidden: $($a.Execute) $($a.Arguments)"
      $line = [IO.File]::ReadAllText($launcher)
      Assert ($line -match 'WindowsPowerShell\\v1\.0\\powershell\.exe' -and $line -match '-File ' -and $line -match ' update -Repo ' -and $line -match 'updater\\bin\\update-pc\.ps1' -and $line -match ', 0, True\)\r\n$') "the pinned copy, hidden and waited for: $line"
      Assert ($a.WorkingDirectory -eq $script:P.Bin -and (Test-Path (Join-Path $script:P.Bin 'update-pc.ps1'))) "working folder $($a.WorkingDirectory)"
      Assert ($a.Arguments -notmatch '(?i)(^|\s)[-/](e|ec|en\w*|c|co\w*)(\s|$)') "no command string: $($a.Arguments)"
      $kinds = @($t.Triggers | ForEach-Object { $_.CimClass.CimClassName })
      Assert ($kinds.Count -eq 3 -and @($kinds | Where-Object { $_ -eq 'MSFT_TaskLogonTrigger' }).Count -eq 1 -and @($kinds | Where-Object { $_ -eq 'MSFT_TaskDailyTrigger' }).Count -eq 2) ($kinds -join ',')
      $dailies = @($t.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskDailyTrigger' })
      $want = (ConvertFrom-NewYorkTime '09:00').ToString('HH:mm')
      $want17 = (ConvertFrom-NewYorkTime '17:00').ToString('HH:mm')
      $wantBoth = (@($want, $want17) | Sort-Object) -join ','
      $got = @($dailies | ForEach-Object { ([datetime]$_.StartBoundary).ToString('HH:mm') } | Sort-Object)
      Assert (($got -join ',') -eq $wantBoth) "daily at $want and $want17 local (09:00 and 17:00 New York, the default): $($got -join ',')"
      foreach ($daily in $dailies) {
        Assert ($daily.DaysInterval -eq 1) "every day: $($daily.DaysInterval)"
        Assert ($daily.StartBoundary -notmatch '(Z|[+-]\d\d:\d\d)$') "local wall-clock time, no UTC offset: $($daily.StartBoundary)"
        Assert (-not $daily.Repetition.Interval) "no repetition: '$($daily.Repetition.Interval)'"
      }
      Assert ($t.Settings.StartWhenAvailable -eq $false) 'a missed daily run is not started later (it could land in the trading day)'
      $logon = @($t.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' })[0]
      Assert ($logon.Delay -eq 'PT2M' -and $logon.UserId) "logon trigger for this user, delay $($logon.Delay)"
      Assert (-not $logon.Repetition.Interval) 'the sign-in check does not repeat'
      Assert ($t.Settings.ExecutionTimeLimit -eq 'PT30M') "time limit $($t.Settings.ExecutionTimeLimit)"
      # drifted daily times (time zone or DST dates unlike New York's) are moved back at the task's own next run: this test
      # stands in for it (the pinned copy, not elevated; the CI runner is an administrator)
      $keepSelf = $script:UpdaterSelf
      function Test-Elevated { return $false }
      $script:UpdaterSelf = Join-Path $script:P.Bin 'update-pc.ps1'
      $logonOnly = @($t.Triggers | Where-Object { $_.CimClass.CimClassName -ne 'MSFT_TaskDailyTrigger' })
      $wrong = @((New-DailyTrigger ([datetime]'2026-01-01 03:00')), (New-DailyTrigger ([datetime]'2026-01-01 04:00')))
      Set-ScheduledTask -TaskName $TaskName -Trigger (@($logonOnly) + $wrong) | Out-Null
      [void](Sync-DailyTrigger)
      $t2 = Get-ScheduledTask -TaskName $TaskName
      $d2 = @($t2.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskDailyTrigger' })
      $got = @($d2 | ForEach-Object { ([datetime]$_.StartBoundary).ToString('HH:mm') } | Sort-Object)
      Assert (($got -join ',') -eq $wantBoth -and @($d2 | Where-Object { $_.StartBoundary -match '(Z|[+-]\d\d:\d\d)$' }).Count -eq 0) "moved back to $want and $want17 local, no offset: $($got -join ',')"
      Assert (@($t2.Triggers).Count -eq 3 -and (Get-Text $script:P.Log) -match 'the daily check moved from 03:00,04:00') 'the sign-in trigger kept, and the move logged'
      # a task with the 09:00 check alone (registered before 09:00 and 17:00): the task's own run adds 17:00 in place
      try {
        $one = @(New-DailyTrigger (ConvertFrom-NewYorkTime '09:00'))
        Set-ScheduledTask -TaskName $TaskName -Trigger (@($logonOnly) + $one) | Out-Null
        $before = @((Get-ScheduledTask -TaskName $TaskName).Actions)[0]
        $res = Sync-DailyTrigger
        $t3 = Get-ScheduledTask -TaskName $TaskName
        $got = @($t3.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskDailyTrigger' } | ForEach-Object { ([datetime]$_.StartBoundary).ToString('HH:mm') } | Sort-Object)
        Assert ($res.ok -and -not $res.note -and ($got -join ',') -eq $wantBoth) "17:00 added: $($got -join ',') / $($res.note) $($res.error)"
        $a3 = @($t3.Actions)[0]
        Assert ($a3.Execute -eq $before.Execute -and $a3.Arguments -eq $before.Arguments -and @($t3.Triggers).Count -eq 3) 'the action and the sign-in trigger as they were'
      } finally { $script:UpdaterSelf = $keepSelf }
      Assert-Code (Invoke-Unregister) 0 'unregister OK'
      Assert (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) 'gone'
      Assert (-not (Test-Path -LiteralPath $launcher)) 'the launcher gone too'
    } finally {
      if (Get-Variable keepSelf -ErrorAction SilentlyContinue) { $script:UpdaterSelf = $keepSelf }
      if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
      Remove-Item -LiteralPath (Join-Path $script:P.Bin 'update-pc.hidden.vbs') -Force -ErrorAction SilentlyContinue
    }
  }
  Test 'register in a time zone with DST: the XML StartBoundary has no offset, and 17:05 New York stays 17:05 across DST and time zones (review 3 S2)' {
    $script:TaskName = 'ChartEngine Updater DST ' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $TaskName = $script:TaskName
    $DailyAt = '17:05'     # an explicit -DailyAt (the default is 09:00): it wins, and this test's times follow it
    $origTz = "$(& tzutil /g)".Trim()
    if (-not $origTz) { $origTz = [TimeZoneInfo]::Local.Id }
    $xmlBoundary = {
      $x = [xml](Export-ScheduledTask -TaskName $TaskName)
      return [string]$x.Task.Triggers.CalendarTrigger.StartBoundary
    }
    try {
      & tzutil /s 'Eastern Standard Time'
      Assert ($LASTEXITCODE -eq 0) "tzutil /s: $LASTEXITCODE"
      [TimeZoneInfo]::ClearCachedData()
      Assert ([TimeZoneInfo]::Local.Id -eq 'Eastern Standard Time' -and [TimeZoneInfo]::Local.SupportsDaylightSavingTime) "the runner is on New York time now: $([TimeZoneInfo]::Local.Id)"
      $raw = (New-ScheduledTaskTrigger -Daily -At (ConvertFrom-NewYorkTime '17:05')).StartBoundary
      Microsoft.PowerShell.Utility\Write-Host "pc-updater dst: New-ScheduledTaskTrigger -At alone writes StartBoundary $raw"
      Assert-Code (Invoke-Register) 0 'register OK'
      $sb = & $xmlBoundary
      Microsoft.PowerShell.Utility\Write-Host "pc-updater xml: after register, the task XML has <StartBoundary>$sb</StartBoundary>"
      Assert ($sb -match '^\d{4}-\d\d-\d\dT17:05:00$') "the XML StartBoundary is 17:05 local wall-clock time with no offset: $sb"
      $cim = [string](@((Get-ScheduledTask -TaskName $TaskName).Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskDailyTrigger' })[0].StartBoundary)
      Assert ($cim -eq $sb) "the CIM API reads the same string: $cim"
      # the conversion across DST, on a PC in New York: 17:05 in summer and in winter, the same wall-clock time
      Assert ((ConvertFrom-NewYorkTime '17:05' ([datetime]'2026-07-15')).ToString('HH:mm') -eq '17:05' -and (ConvertFrom-NewYorkTime '17:05' ([datetime]'2026-12-15')).ToString('HH:mm') -eq '17:05') 'summer and winter'
      # what Task Scheduler itself computes for a winter day: wall-clock time against a summer offset (diagnostic)
      $others = @((Get-ScheduledTask -TaskName $TaskName).Triggers | Where-Object { $_.CimClass.CimClassName -ne 'MSFT_TaskDailyTrigger' })
      $w = New-DailyTrigger ([datetime]'2026-12-15 17:05')
      Set-ScheduledTask -TaskName $TaskName -Trigger (@($others) + @($w)) | Out-Null
      $nextLocal = (Get-ScheduledTaskInfo -TaskName $TaskName).NextRunTime
      $o = New-ScheduledTaskTrigger -Daily -At ([datetime]'2026-12-15 17:05'); $o.StartBoundary = '2026-12-15T17:05:00-04:00'
      Set-ScheduledTask -TaskName $TaskName -Trigger (@($others) + @($o)) | Out-Null
      $nextUtc = (Get-ScheduledTaskInfo -TaskName $TaskName).NextRunTime
      Microsoft.PowerShell.Utility\Write-Host "pc-updater dst: first winter run (2026-12-15), Task Scheduler's NextRunTime: wall-clock trigger $nextLocal; trigger with the summer offset -04:00 $nextUtc"
      # a trigger written with an offset (as New-ScheduledTaskTrigger does) is drift: the task's own next run rewrites it
      # (this test stands in for it: the pinned copy, not elevated)
      Assert ((& $xmlBoundary) -match '-04:00$') 'the offset trigger is in place'
      $keepSelf = $script:UpdaterSelf
      function Test-Elevated { return $false }
      $script:UpdaterSelf = Join-Path $script:P.Bin 'update-pc.ps1'
      $res = Sync-DailyTrigger
      $sb2 = & $xmlBoundary
      Assert ($res.ok -and $sb2 -match 'T17:05:00$') "rewritten as wall-clock time: $sb2"
      Assert ((Get-Text $script:P.Log) -match 'it was kept on UTC') 'the log says why it moved'
      # a trip to another time zone: 17:05 New York is 14:05 on a Pacific clock, still with no offset
      & tzutil /s 'Pacific Standard Time'
      [TimeZoneInfo]::ClearCachedData()
      $res = Sync-DailyTrigger
      $sb3 = & $xmlBoundary
      Microsoft.PowerShell.Utility\Write-Host "pc-updater xml: after a move to Pacific time, <StartBoundary>$sb3</StartBoundary>"
      Assert ($res.ok -and $sb3 -match '^\d{4}-\d\d-\d\dT14:05:00$') "moved to 14:05 Pacific, no offset: $sb3"
      $script:UpdaterSelf = $keepSelf
      Assert-Code (Invoke-Unregister) 0 'unregister OK'
    } finally {
      if (Get-Variable keepSelf -ErrorAction SilentlyContinue) { $script:UpdaterSelf = $keepSelf }
      & tzutil /s $origTz
      [TimeZoneInfo]::ClearCachedData()
      if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
      Remove-Item -LiteralPath (Join-Path $script:P.Bin 'update-pc.hidden.vbs') -Force -ErrorAction SilentlyContinue
    }
    Assert ([TimeZoneInfo]::Local.Id -eq $origTz -or "$(& tzutil /g)".Trim() -eq $origTz) "the runner's time zone is back: $([TimeZoneInfo]::Local.Id)"
  }
} else { Skip '-InstallChartBridge migration on a real throwaway task' 'Windows only'; Skip 'the launcher runs for real (wscript.exe)' 'Windows only'; Skip 'register: the scheduled task' 'Windows only'; Skip 'register in a time zone with DST' 'Windows only' }

# ---------------------------------------------------------------------------------------------- done

try { Remove-Item -Recurse -Force $tmpRoot } catch { }
Microsoft.PowerShell.Utility\Write-Host "pc-updater: $script:Passed passed, $script:Failed failed, $script:Skipped skipped"
if ($script:Failed) { exit 1 }
exit 0
