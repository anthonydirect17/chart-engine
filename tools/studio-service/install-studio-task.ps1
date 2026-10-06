<#
.SYNOPSIS
  Start the Markup Studio by itself when you sign in (no window, no desktop icon), with its Work list.

.DESCRIPTION
  Registers the scheduled task "Markup Studio" for the signed-in Windows user: at logon it runs the Studio with
  pythonw (no console window) as

      pythonw tools\markup_studio.py --work=<Work> --port=<Port> --no-browser --log=<Log> [--allow-origin=...]
                                     [--tickreplay=<TickReplay>] [--data=<Data>]

  then starts it once and waits up to 60 s for http://127.0.0.1:<Port>/api/work to answer. The Studio binds 127.0.0.1
  only and is read only. Restart on failure: 3 times, a minute apart. One instance at a time (IgnoreNew).
  -Uninstall stops and removes the task (the work folder, marks and logs are left as they are).
  Run it from a normal (not elevated) PowerShell, as the user who grades.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\studio-service\install-studio-task.ps1 `
    -Work E:\SchwabDesk_bulk\studio_work -AllowOrigin https://desk.example.com
#>
param(
  [string]$Work,
  [string]$AllowOrigin = '',
  [int]$Port = 8790,
  [string]$TickReplay = '',
  [string]$Data = '',
  [string]$Log = '',
  [string]$TaskName = 'Markup Studio',
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

if ($Uninstall) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $t) { Write-Host "no task '$TaskName': nothing to remove"; exit 0 }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "removed the task '$TaskName'"
  exit 0
}

if (-not $Work) { throw 'give the work folder with -Work DIR' }
if (-not (Test-Path -LiteralPath $Work -PathType Container)) { throw "the work folder $Work does not exist" }
if ($Port -lt 1024 -or $Port -gt 65535 -or $Port -eq 8765) { throw "port ${Port}: pick one from 1024 to 65535 (8765 is ChartBridge's)" }
$Work = (Resolve-Path -LiteralPath $Work).Path
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$studio = Join-Path $repo 'tools\markup_studio.py'
if (-not (Test-Path -LiteralPath $studio)) { throw "no Studio at $studio" }
if (-not $Log) { $Log = Join-Path $Work '_studio.log' }

# the Python that runs the Studio today (py -3), with numpy; its pythonw.exe has no console window
$python = (& py -3 -c "import sys, numpy; print(sys.executable)" 2>&1 | Select-Object -Last 1)
if ($LASTEXITCODE -ne 0) { throw "py -3 cannot run Python with numpy: $python" }
$pythonw = Join-Path (Split-Path -Parent $python) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonw)) { throw "no pythonw.exe next to $python" }

$q = { param($s) '"' + $s + '"' }
$argList = @((& $q $studio), "--work=$(& $q $Work)", "--port=$Port", '--no-browser', "--log=$(& $q $Log)")
if ($AllowOrigin) { $argList += "--allow-origin=$AllowOrigin" }
if ($TickReplay) { $argList += "--tickreplay=$(& $q $TickReplay)" }
if ($Data) { $argList += "--data=$(& $q $Data)" }

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $pythonw -Argument ($argList -join ' ') -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Markup Studio (read only, this PC only): the Work list for grading. tools/studio-service/install-studio-task.ps1' `
  -Force | Out-Null
Write-Host "registered '$TaskName' for $user at logon:"
Write-Host "  $pythonw $($argList -join ' ')"

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName
$url = "http://127.0.0.1:$Port/api/work"
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3
    if ($r.StatusCode -eq 200) {
      $j = $r.Content | ConvertFrom-Json
      Write-Host "the Studio answers on $url : $(@($j.items).Count) work item(s), open now: $($j.current)"
      exit 0
    }
  } catch { Start-Sleep -Milliseconds 500 }
}
Write-Host "the Studio did not answer on $url within 60 s; the last lines of $Log :"
if (Test-Path -LiteralPath $Log) { Get-Content -LiteralPath $Log -Tail 20 }
exit 1
