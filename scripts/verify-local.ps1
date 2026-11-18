param(
    [string]$ProjectName = "chatify-realtime-local",
    [string]$EnvFile = "D:\chatify-realtime\.env.local",
    [string]$ComposeFile = "D:\chatify-realtime\infra\docker\compose.yaml",
    [switch]$StartStack,
    [switch]$SkipBrowser
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$compose = @("--project-name", $ProjectName, "--env-file", $EnvFile, "-f", $ComposeFile)

function Invoke-Checked([string]$name, [scriptblock]$action) {
    Write-Host "[verify] $name"
    & $action
    if ($LASTEXITCODE -ne 0) { throw "$name failed with exit code $LASTEXITCODE" }
}

Invoke-Checked "Compose config" { docker compose @compose config --quiet }
if ($StartStack) {
    Invoke-Checked "Start stack" { docker compose @compose up -d --build }
}
Invoke-Checked "Service status" { docker compose @compose ps }
Invoke-Checked "API/media/signaling/outbox smoke" { node (Join-Path $root "harness\smoke.cjs") }
Invoke-Checked "Failure/load" { node (Join-Path $root "harness\failure-load.cjs") }
Invoke-Checked "Presence disconnect and room history" { node (Join-Path $root "harness\presence-disconnect-e2e.cjs") }
Invoke-Checked "TURN UDP relay" { powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\turn-udp-drill.ps1") -ProjectName $ProjectName -EnvFile $EnvFile -ComposeFile $ComposeFile }
Invoke-Checked "Prometheus monitoring" { npm --prefix (Join-Path $root "harness") run monitoring }
if (-not $SkipBrowser) {
    $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $root ".cache\ms-playwright"
    Invoke-Checked "Browser E2E" { npm --prefix (Join-Path $root "harness") run browser-e2e }
    Invoke-Checked "Chrome and Edge E2E" { npm --prefix (Join-Path $root "harness") run cross-browser-e2e }
}
Write-Output "Local verification gate passed"
