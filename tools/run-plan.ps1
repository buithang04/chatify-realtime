param(
    [ValidateRange(1, 20)]
    [int]$MaxTasks = 1,
    [switch]$NoAutomaticReview
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TodoPath = Join-Path $ProjectRoot 'tasks\todo.md'
$RunnerPath = Join-Path $ProjectRoot 'tools\run-next-task.ps1'

for ($i = 1; $i -le $MaxTasks; $i++) {
    $todoBefore = Get-Content -Raw $TodoPath
    if ($todoBefore -notmatch '(?m)^- \[ \]') {
        Write-Output "Plan complete: no unchecked tasks remain."
        exit 0
    }

    Write-Output "Running planned task $i of $MaxTasks..."
    & $RunnerPath -NoAutomaticReview:$NoAutomaticReview
    if ($LASTEXITCODE -ne 0) {
        throw "Stopping plan runner because the task runner returned $LASTEXITCODE"
    }

    $todoAfter = Get-Content -Raw $TodoPath
    if ($todoAfter -eq $todoBefore) {
        throw 'Stopping: Codex did not change tasks/todo.md. Review the last message and resolve the blocker before retrying.'
    }
}

Write-Output "Stopped after $MaxTasks task(s). Review the build log before continuing."
