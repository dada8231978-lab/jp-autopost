# Windows Task Scheduler entry point.
# Register a daily 07:00 task with:
#
#   $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
#                -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PWD\scripts\run.ps1`""
#   $trigger = New-ScheduledTaskTrigger -Daily -At 7:00am
#   Register-ScheduledTask -TaskName "GhostDailyPost" -Action $action -Trigger $trigger

$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $PSScriptRoot
Set-Location $projectDir

$logDir = Join-Path $projectDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir ("post-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

"=== {0} starting ===" -f (Get-Date -Format 'o') | Add-Content -Path $log -Encoding utf8

try {
    & npx tsx src/index.ts @args 2>&1 | Tee-Object -FilePath $log -Append
    if ($LASTEXITCODE -ne 0) { throw "run failed with exit code $LASTEXITCODE" }
}
catch {
    "ERROR: $_" | Add-Content -Path $log -Encoding utf8
    exit 1
}
finally {
    "=== {0} finished ===" -f (Get-Date -Format 'o') | Add-Content -Path $log -Encoding utf8
}
