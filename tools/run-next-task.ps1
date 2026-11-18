param(
    [switch]$NoAutomaticReview
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TodoPath = Join-Path $ProjectRoot 'tasks\todo.md'
$LogPath = Join-Path $ProjectRoot 'harness\codex-last-message.md'

if (-not (Test-Path $TodoPath)) {
    throw "Missing task list: $TodoPath"
}

try {
    Resolve-DnsName 'chatgpt.com' -ErrorAction Stop | Out-Null
} catch {
    throw 'Codex service is unreachable because DNS cannot resolve chatgpt.com. Fix DNS/proxy/firewall access, then rerun this script.'
}

$todo = Get-Content -Raw $TodoPath
if ($todo -notmatch '(?m)^- \[ \]') {
    Write-Output 'No unchecked tasks remain.'
    return
}

$prompt = @'
Read AGENTS.md, GOALS.md, PLANS.md, tasks/plan.md, tasks/todo.md, and harness/build-log.md before acting.
Select only the first unchecked task whose dependencies are complete. Implement exactly that task.
Run its focused tests and verification commands. Do not start the next task.
Record observed evidence in harness/build-log.md and mark the task complete only if verification passes.
Stop and report if a required decision, external permission, or environment dependency blocks the task.
'@

$codexArgs = @(
    '--cd', $ProjectRoot,
    '--skip-git-repo-check',
    '--output-last-message', $LogPath
)

if (-not $NoAutomaticReview) {
    $codexArgs += '--approve-for-me'
} else {
    $codexArgs += '--sandbox', 'workspace-write'
}

& codex exec @codexArgs $prompt

if ($LASTEXITCODE -ne 0) {
    throw "Codex task runner failed with exit code $LASTEXITCODE"
}
