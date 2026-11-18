param(
    [string]$ProjectName = "chatify-realtime-local",
    [string]$EnvFile = "D:\chatify-realtime\.env.local",
    [string]$ComposeFile = "D:\chatify-realtime\infra\docker\compose.yaml"
)

$ErrorActionPreference = "Stop"

function Get-EnvValue([string]$name, [string]$fallback) {
    if (Test-Path -LiteralPath $EnvFile) {
        $line = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
        if ($null -ne $line) { return $line.Substring($name.Length + 1) }
    }
    return $fallback
}

$compose = @("--project-name", $ProjectName, "--env-file", $EnvFile, "-f", $ComposeFile)
$containerId = (& docker compose @compose ps -q coturn).Trim()
if ([string]::IsNullOrWhiteSpace($containerId)) { throw "coturn container is not running" }
$turnSecret = Get-EnvValue "TURN_SECRET" ""
if ([string]::IsNullOrWhiteSpace($turnSecret)) { throw "TURN_SECRET is required" }

# Use the container network IP as the peer. Coturn intentionally rejects loopback peers by default.
$drill = 'ip=$(hostname -i); turnutils_peer -L "$ip" -p 3480 >/tmp/chatify-turn-peer.log 2>&1 & peer=$!; trap "kill $peer 2>/dev/null || true" EXIT; sleep 1; turnutils_uclient -u chatify -w "$TURN_PASSWORD" -p 3478 -e "$ip" -r 3480 -n 2 "$ip"'
& docker exec -e "TURN_PASSWORD=$turnSecret" $containerId sh -c $drill
if ($LASTEXITCODE -ne 0) { throw "TURN UDP relay drill failed" }
Write-Output "TURN UDP relay drill passed"
