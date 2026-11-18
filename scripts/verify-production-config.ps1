param(
    [string]$EnvFile = "D:\chatify-realtime\.env.production"
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $EnvFile)) {
    throw "Production env file not found: $EnvFile"
}

$values = @{}
foreach ($line in Get-Content -LiteralPath $EnvFile) {
    if ($line -match '^\s*#' -or $line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { continue }
    $values[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
}

function Value([string]$name) { return [string]($values[$name]) }
function Require([string]$name) {
    if ([string]::IsNullOrWhiteSpace((Value $name))) { $script:errors += "$name is required" }
}
function RequireStrong([string]$name) {
    Require $name
    $value = Value $name
    if ($value.Length -lt 32 -or $value -match 'replace|change-me|example|placeholder') { $script:errors += "$name must be a strong non-placeholder secret" }
}
function RequireNonPlaceholder([string]$name) {
    Require $name
    $value = Value $name
    if ($value -match 'replace|change-me|example|placeholder') { $script:errors += "$name must not be a placeholder" }
}
function RequireHttps([string]$name) {
    Require $name
    foreach ($origin in (Value $name -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
        $uri = $null
        if (-not [uri]::TryCreate($origin, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne "https") { $script:errors += "$name must contain only absolute https URLs" }
    }
}

$errors = @()
if ((Value "APP_ENV").ToLowerInvariant() -ne "production") { $errors += "APP_ENV must be production" }
RequireStrong "JWT_SECRET"
RequireStrong "INTERNAL_SERVICE_TOKEN"
if ((Value "COOKIE_SECURE").ToLowerInvariant() -ne "true") { $errors += "COOKIE_SECURE must be true" }
RequireHttps "CORS_ORIGIN"
RequireHttps "MEDIA_CORS_ORIGIN"
RequireHttps "WEB_API_URL"
RequireHttps "WEB_SIGNALING_URL"
RequireHttps "WEB_MEDIA_URL"
Require "WEB_CSP_CONNECT_SRC"
$csp = Value "WEB_CSP_CONNECT_SRC"
if ($csp -match '\*|localhost|127\.0\.0\.1|http://|ws://') { $errors += "WEB_CSP_CONNECT_SRC must use only HTTPS/WSS origins and must not contain wildcard or local origins" }
foreach ($endpointName in @("WEB_API_URL", "WEB_SIGNALING_URL", "WEB_MEDIA_URL")) {
    $endpoint = Value $endpointName
    if ($endpoint -and $csp.IndexOf($endpoint, [StringComparison]::Ordinal) -lt 0) { $errors += "WEB_CSP_CONNECT_SRC must include $endpointName" }
    if ($endpointName -eq "WEB_SIGNALING_URL") {
        $websocketEndpoint = $endpoint -replace '^https://', 'wss://'
        if ($websocketEndpoint -and $csp.IndexOf($websocketEndpoint, [StringComparison]::Ordinal) -lt 0) { $errors += "WEB_CSP_CONNECT_SRC must include WSS signaling origin" }
    }
}
Require "RTC_ANNOUNCED_ADDRESS"
if ((Value "RTC_ANNOUNCED_ADDRESS") -match '^(127\.0\.0\.1|localhost|0\.0\.0\.0)$') { $errors += "RTC_ANNOUNCED_ADDRESS must be public" }
Require "RTC_TURN_URL"
Require "RTC_TURN_USERNAME"
RequireNonPlaceholder "RTC_TURN_CREDENTIAL"
RequireHttps "OBJECT_STORAGE_PUBLIC_ENDPOINT"
RequireStrong "POSTGRES_PASSWORD"
RequireStrong "REDIS_PASSWORD"
RequireNonPlaceholder "RUSTFS_ACCESS_KEY"
RequireStrong "RUSTFS_SECRET_KEY"

if ($errors.Count -gt 0) {
    Write-Error ("Production configuration rejected:`n- " + ($errors -join "`n- "))
    exit 1
}

Write-Output "Production configuration passed: $EnvFile"
