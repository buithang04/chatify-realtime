param(
    [string]$ProjectName = "chatify-realtime-local",
    [string]$EnvFile = "D:\chatify-realtime\.env.local",
    [string]$ComposeFile = "D:\chatify-realtime\infra\docker\compose.yaml",
    [string]$RestoreDatabase = "chatify_restore_drill"
)

$ErrorActionPreference = "Stop"

if ($RestoreDatabase -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
    throw "RestoreDatabase must be a safe PostgreSQL identifier"
}

function Get-EnvValue([string]$name, [string]$fallback) {
    if (Test-Path -LiteralPath $EnvFile) {
        $line = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
        if ($null -ne $line) { return $line.Substring($name.Length + 1) }
    }
    return $fallback
}

$root = Split-Path -Parent $PSScriptRoot
$backupDirectory = Join-Path $root "backup"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dumpName = "chatify-$timestamp.dump"
$dumpPath = Join-Path $backupDirectory $dumpName
$postgresUser = Get-EnvValue "POSTGRES_USER" "chatify"
$postgresDatabase = Get-EnvValue "POSTGRES_DB" "chatify"
$containerId = (& docker compose --project-name $ProjectName --env-file $EnvFile -f $ComposeFile ps -q postgres).Trim()

if ([string]::IsNullOrWhiteSpace($containerId)) {
    throw "PostgreSQL container is not running"
}

New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
$compose = @("--project-name", $ProjectName, "--env-file", $EnvFile, "-f", $ComposeFile)
$remoteDump = "/tmp/$dumpName"
$dropSql = "DROP DATABASE $RestoreDatabase WITH (FORCE);"
$restoreDatabaseCreated = $false

try {
	& docker compose @compose exec -T postgres pg_dump -U $postgresUser -d $postgresDatabase -Fc -f $remoteDump
    if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }

    & docker cp "${containerId}:$remoteDump" $dumpPath
    if ($LASTEXITCODE -ne 0) { throw "docker cp failed" }

	$databaseQueryOutput = & docker compose @compose exec -T postgres psql -v ON_ERROR_STOP=1 -At -U $postgresUser -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$RestoreDatabase';"
	$databaseExists = if ($null -eq $databaseQueryOutput) { "" } else { ($databaseQueryOutput -join "").Trim() }
    if ($LASTEXITCODE -ne 0) { throw "restore database existence check failed" }
    if ($databaseExists -eq "1") { throw "refusing to overwrite existing restore database: $RestoreDatabase" }
	$createSql = "CREATE DATABASE $RestoreDatabase;"
	& docker compose @compose exec -T postgres psql -v ON_ERROR_STOP=1 -U $postgresUser -d postgres -c $createSql
    if ($LASTEXITCODE -ne 0) { throw "restore database creation failed" }
	$restoreDatabaseCreated = $true

    & docker cp $dumpPath "${containerId}:$remoteDump"
    if ($LASTEXITCODE -ne 0) { throw "restore dump copy failed" }
	& docker compose @compose exec -T postgres pg_restore --exit-on-error -U $postgresUser -d $RestoreDatabase $remoteDump
    if ($LASTEXITCODE -ne 0) { throw "pg_restore failed" }

	& docker compose @compose exec -T postgres psql -v ON_ERROR_STOP=1 -At -U $postgresUser -d $RestoreDatabase -c "SELECT count(*) FROM schema_migrations;"
    if ($LASTEXITCODE -ne 0) { throw "restore verification failed" }
    Write-Output "Backup and restore drill passed: $dumpPath"
}
finally {
	if ($restoreDatabaseCreated) {
		& docker compose @compose exec -T postgres psql -v ON_ERROR_STOP=1 -U $postgresUser -d postgres -c $dropSql | Out-Null
	}
	$cleanupDumpCommand = 'rm -f ' + $remoteDump
	& docker compose @compose exec -T postgres sh -c $cleanupDumpCommand | Out-Null
}
