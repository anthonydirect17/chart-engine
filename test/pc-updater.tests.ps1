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
# GitHub's API as the updater reads it: check runs and statuses for a commit (the real Get-CiState runs on these).
function Get-RepoSlug { return 'owner/chart-engine' }
function Invoke-GitHubJson([string]$Path) {
  if ($script:FakeCi -eq 'unknown') { throw (New-Object System.Net.WebException 'stub: no network') }
  if ($Path -match '/status\?') { return @{ statuses = @() } }
  $win = @{ success = @('completed', 'success'); pending = @('in_progress', $null); failure = @('completed', 'failure') }[$script:FakeCi]
  return @{ total_count = 3; check_runs = @(
      @{ name = 'unit (ubuntu-latest)'; status = 'completed'; conclusion = 'success' },
      @{ name = 'unit (windows-latest)'; status = $win[0]; conclusion = $win[1] },
      @{ name = 'deploy'; status = 'completed'; conclusion = 'success' }) }
}
function Get-DiagVersion {
  if ($script:FakeDiag) { return @{ ok = $true; version = $script:FakeDiag; detail = 'stub /diag' } }
  return @{ ok = $false; version = $null; detail = 'stub: ChartBridge not running' }
}
function Show-Toast([string]$Title, [string]$Text) { $script:Toasts += $Text; return $true }
function Write-Host { param([Parameter(ValueFromRemainingArguments = $true)]$Rest) if ("$Rest" -match '^\s+(ok|FAIL|skip) |^(OK|STOP):|^pc-updater') { Microsoft.PowerShell.Utility\Write-Host "$Rest" } }

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
function Get-Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
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
  $green = @(@{ name = 'unit (ubuntu-latest)'; status = 'completed'; conclusion = 'success' }, @{ name = 'unit (windows-latest)'; status = 'completed'; conclusion = 'success' }, @{ name = 'deploy'; status = 'completed'; conclusion = 'success' })
  Assert ((Resolve-CiState $green @()).state -eq 'success') 'success'
}
Test 'CI: windows-latest missing is not success (pending)' {
  $r = Resolve-CiState @(@{ name = 'unit (ubuntu-latest)'; status = 'completed'; conclusion = 'success' }) @()
  Assert ($r.state -eq 'pending' -and $r.detail -match 'windows-latest') $r.detail
}
Test 'CI: a failed required job is failure' {
  $r = Resolve-CiState @(@{ name = 'unit (ubuntu-latest)'; status = 'completed'; conclusion = 'success' }, @{ name = 'unit (windows-latest)'; status = 'completed'; conclusion = 'failure' }) @()
  Assert ($r.state -eq 'failure') $r.detail
}
Test 'CI: any other failed check or status is failure; running is pending; nothing is pending' {
  $ok = @(@{ name = 'unit (ubuntu-latest)'; status = 'completed'; conclusion = 'success' }, @{ name = 'unit (windows-latest)'; status = 'completed'; conclusion = 'success' })
  Assert ((Resolve-CiState ($ok + @(@{ name = 'deploy'; status = 'completed'; conclusion = 'failure' })) @()).state -eq 'failure') 'other check failed'
  Assert ((Resolve-CiState $ok @(@{ context = 'x'; state = 'error' })).state -eq 'failure') 'status error'
  Assert ((Resolve-CiState ($ok + @(@{ name = 'deploy'; status = 'in_progress'; conclusion = $null })) @()).state -eq 'pending') 'running'
  Assert ((Resolve-CiState @() @()).state -eq 'pending') 'no results'
  Assert ((Resolve-CiState @(@{ name = 'unit (ubuntu-latest)'; status = 'completed'; conclusion = 'skipped' }, @{ name = 'unit (windows-latest)'; status = 'completed'; conclusion = 'success' }) @()).state -eq 'failure') 'a skipped required job is not success'
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
  $script:FakeDiag = '0.3.1'
  [void](Get-CompiledChartBridge ($s = Read-State)); Save-State $s
  $script:FakeDiag = $null
  $c = Get-CompiledChartBridge (Read-State)
  Assert ($c.version -eq '0.3.1' -and $c.source -eq 'recorded') "$($c.version) $($c.source)"
}
Test 'compat gate: page needs a newer ChartBridge, so no update' {
  $script:FakeDiag = '0.3.1'
  $r = Run-Update
  Assert ($r.outcome -eq 'needs_chartbridge') $r.outcome
  Assert ($r.reason -match '0\.3\.2' -and $r.reason -match '0\.3\.1') $r.reason
  Assert (-not (Test-Path (Get-WwwFile 'live.js'))) 'no page file'
}

# ---------------------------------------------------------------------------------------------- staging and the swap

$script:FirstBuild = $null
Test 'green, compatible: staged, then installed file by file; nothing else in www touched' {
  $script:FakeDiag = '0.3.3'
  $r = Run-Update
  Assert ($r.outcome -eq 'updated') "$($r.outcome) $($r.reason)"
  foreach ($w in $manifest['www']) {
    Assert (Get-TextSame (Get-WwwFile $w['to']) (Get-LocalPath $src $w['from'])) "$($w['to']) matches the commit"
  }
  Assert (@(Get-ChildItem -Recurse -LiteralPath $script:P.Www -Filter '*.upd-tmp').Count -eq 0) 'no temporary file left'
  Assert ((Get-Hash (Get-WwwFile 'anthony-notes.txt')) -eq $notesHash) 'a file of Anthony''s in www untouched'
  $u = Get-UpdateJson
  Assert ($u['page']['build'] -eq $r.stage.build -and $u['page']['commit'] -eq $c1 -and $u['page']['installedAt'] -gt 0) 'update.json'
  Assert ($u['chartBridge']['compiled'] -eq '0.3.3') 'update.json compiled ChartBridge'
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
Test 'a new commit on main is installed; the previous page is kept; the clone fast forwards' {
  $script:C2 = Commit 'page change' { Put (Get-LocalPath $src 'live/live.js') ((Get-Text (Get-LocalPath $src 'live/live.js')) + "`n/* a page change */`n") }
  $r = Run-Update
  Assert ($r.outcome -eq 'updated') $r.outcome
  Assert ((Get-Text (Get-WwwFile 'live.js')) -match 'a page change') 'new live.js'
  Assert ((Get-Text (Get-LocalPath (Join-Path $script:P.Previous 'page') 'live.js')) -notmatch 'a page change') 'old live.js kept'
  Assert ((Read-JsonFile (Join-Path $script:P.Previous 'previous.json'))['build'] -eq $script:FirstBuild) 'previous build'
  Assert ((G $clone @('rev-parse', 'HEAD')) -eq $script:C2) 'clone moved to main'
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
  $script:CbCommit = Commit 'ChartBridge 0.3.9 and a page that needs it' { Set-CbVersion '0.3.9'; Set-MinCb '0.3.9'; Put (Get-LocalPath $src 'live/live.js') ((Get-Text (Get-LocalPath $src 'live/live.js')) + "`n/* needs 0.3.9 */`n") }
  $script:Toasts = @()
  $r = Run-Update
  Assert ($r.outcome -eq 'needs_chartbridge') $r.outcome
  Assert ((Read-JsonFile (Join-Path $script:P.Staged 'stage.json'))['chartBridgeVersion'] -eq '0.3.9') 'staged 0.3.9'
  Assert (Test-Path (Join-Path (Join-Path $script:P.Staged 'addons') 'ChartBridge.cs')) 'add-on staged under updater\staged'
  Assert ((Get-UpdateJson)['chartBridge']['ready'] -eq '0.3.9') 'update.json: ready'
  Assert ((Read-JsonFile $script:P.Status)['chartBridge']['ready'] -eq '0.3.9') 'status.json: ready'
  Assert ($script:Toasts.Count -eq 1 -and $script:Toasts[0] -match '0\.3\.9') 'one notification'
  Assert ((Get-Text (Get-WwwFile 'live.js')) -notmatch 'needs 0\.3\.9') 'page that needs 0.3.9 not installed'
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
Test '-InstallChartBridge (Anthony, flat) copies the staged add-on files and the matching page' {
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
  Assert ((Get-Text (Get-WwwFile 'live.js')) -match 'needs 0\.3\.9') 'the matching page installed'
  Assert ((Get-UpdateJson)['chartBridge']['copied'] -eq '0.3.9' -and -not (Get-UpdateJson)['chartBridge']['ready']) 'update.json: copied, waiting for F5'
  Assert ((Get-Hash $script:P.Config) -eq $configHash -and (Get-Hash (Join-Path $cbDir 'pin.txt')) -eq $pinHash) 'config.txt and pin.txt untouched'
}
Test 'before F5 (ChartBridge not running): the lower of last seen and copied counts' {
  $script:FakeDiag = $null
  $c = Get-CompiledChartBridge (Read-State)
  Assert ($c.version -eq '0.3.3' -and $c.source -eq 'recorded') "$($c.version) $($c.source)"
}
Test 'after F5 /diag shows the new version: confirmed; then without /diag the recorded version counts' {
  $script:FakeDiag = '0.3.9'
  $r = Run-Update
  Assert (@('up_to_date', 'updated') -contains $r.outcome) $r.outcome
  $s = Read-State
  Assert ($s['chartBridge']['installed']['confirmed'] -eq $true) 'confirmed'
  Assert (-not (Get-UpdateJson)['chartBridge']['copied']) 'no longer waiting for F5'
  $script:FakeDiag = $null
  $c = Get-CompiledChartBridge (Read-State)
  Assert ($c.version -eq '0.3.9' -and $c.source -eq 'recorded') "$($c.version) $($c.source)"
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
      @{ addons = @('nt8/ChartBridge.cs'); www = @(@{ from = 'live/a.js'; to = 'update.json' }) })) {
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
Test 'the command line runs under this PowerShell with -File and ends in OK or STOP (status: reads only)' {
  $exe = (Get-Process -Id $PID).Path
  $r = Invoke-Native $exe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path (Join-Path $repoRoot 'nt8') 'update-pc.ps1'), 'status') 300
  $last = Get-LastLine $r.out
  Assert ($last -match '^(OK|STOP): ') "last line OK or STOP: $last $($r.err)"
  Assert (($r.code -eq 0) -eq ($last -match '^OK')) "exit code $($r.code) matches"
}

# ---------------------------------------------------------------------------------------------- the scheduled task (Windows)

if ($IsWin) {
  Test 'register: a task for this user, at sign-in and every 4 hours, IgnoreNew, -File, no admin' {
    $script:TaskName = 'ChartEngine Updater CI ' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $TaskName = $script:TaskName
    try {
      Assert-Code (Invoke-Register) 0 'register OK'
      $t = Get-ScheduledTask -TaskName $TaskName
      Assert ($t.Settings.MultipleInstances -eq 'IgnoreNew') "MultipleInstances $($t.Settings.MultipleInstances)"
      Assert ("$($t.Principal.LogonType)" -eq 'Interactive' -and "$($t.Principal.RunLevel)" -eq 'Limited') "principal $($t.Principal.LogonType) $($t.Principal.RunLevel)"
      $a = $t.Actions[0]
      Assert ($a.Execute -match 'WindowsPowerShell\\v1\.0\\powershell\.exe$') $a.Execute
      Assert ($a.Arguments -match '-File ' -and $a.Arguments -match ' update$' -and $a.Arguments -match 'update-pc\.ps1') $a.Arguments
      Assert ($a.Arguments -notmatch '(?i)(^|\s)[-/](e|ec|en\w*|c|co\w*)(\s|$)') "no command string: $($a.Arguments)"
      $kinds = @($t.Triggers | ForEach-Object { $_.CimClass.CimClassName })
      Assert ($kinds -contains 'MSFT_TaskLogonTrigger' -and $kinds -contains 'MSFT_TaskTimeTrigger') ($kinds -join ',')
      $every = @($t.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger' })[0]
      Assert ($every.Repetition.Interval -eq 'PT4H') "interval $($every.Repetition.Interval)"
      Assert (-not $every.Repetition.Duration) "no end to the repetition: '$($every.Repetition.Duration)'"
      $logon = @($t.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' })[0]
      Assert ($logon.Delay -eq 'PT2M' -and $logon.UserId) "logon trigger for this user, delay $($logon.Delay)"
      Assert ($t.Settings.ExecutionTimeLimit -eq 'PT30M') "time limit $($t.Settings.ExecutionTimeLimit)"
      Assert-Code (Invoke-Unregister) 0 'unregister OK'
      Assert (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) 'gone'
    } finally {
      if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    }
  }
} else { Skip 'register: the scheduled task' 'Windows only' }

# ---------------------------------------------------------------------------------------------- done

try { Remove-Item -Recurse -Force $tmpRoot } catch { }
Microsoft.PowerShell.Utility\Write-Host "pc-updater: $script:Passed passed, $script:Failed failed, $script:Skipped skipped"
if ($script:Failed) { exit 1 }
exit 0
