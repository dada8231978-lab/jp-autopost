# Windows Task Scheduler entry point.
#
# Register a daily 12:00 task with:
#
#   $dir     = "C:\path\to\記事投稿"
#   $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
#                -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$dir\scripts\run.ps1`""
#   $trigger = New-ScheduledTaskTrigger -Daily -At 12:00
#   Register-ScheduledTask -TaskName "DailyAutoPost" -Action $action -Trigger $trigger
#
# DO NOT enable this at the same time as the GitHub Actions workflow. Both
# publish one article per day, so running both produces two articles a day and
# two conflicting commits. Pick one.

$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $PSScriptRoot
Set-Location $projectDir

$logDir = Join-Path $projectDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir ("post-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

function Write-Log([string]$message) {
    "{0}  {1}" -f (Get-Date -Format 'o'), $message | Add-Content -Path $log -Encoding utf8
}

Write-Log '=== starting ==='

try {
    & npx tsx src/index.ts @args | Tee-Object -FilePath $log -Append
    if ($LASTEXITCODE -ne 0) { throw "run failed with exit code $LASTEXITCODE" }
}
catch {
    Write-Log "ERROR: $_"
    Write-Log '=== finished (failed) ==='
    exit 1
}

# ---------------------------------------------------------------------------
# Persist the publish history to git.
#
# data/published.json drives topic rotation and internal linking; data/articles
# holds the bodies `npm run reddit` works from. Losing them means repeated
# topics and unpromotable articles.
#
# Deliberately never fails the run: by this point the article is already
# published, and a git problem must not be reported as a publishing failure.
# ---------------------------------------------------------------------------
if (Test-Path (Join-Path $projectDir '.git')) {
    try {
        & git add data/history data/published.json data/articles
        & git diff --cached --quiet
        if ($LASTEXITCODE -eq 0) {
            Write-Log 'git: nothing to commit'
        }
        else {
            & git commit -m 'chore: record published article [skip ci]' | Out-Null
            Write-Log 'git: committed publish history'

            $branch = (& git rev-parse --abbrev-ref HEAD).Trim()
            & git remote get-url origin | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Log 'git: no origin remote, skipping push'
            }
            else {
                # A cloud run may have landed while this one was generating.
                & git pull --rebase --autostash origin $branch | Out-Null
                & git push origin $branch | Out-Null
                if ($LASTEXITCODE -eq 0) {
                    Write-Log "git: pushed to origin/$branch"
                }
                else {
                    Write-Log "git: push failed (exit $LASTEXITCODE) - commit is kept locally, push it manually"
                }
            }
        }
    }
    catch {
        Write-Log "git: skipped after an error - $_"
    }
}
else {
    Write-Log 'git: not a repository, skipping'
}

Write-Log '=== finished ==='
