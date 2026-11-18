param(
    [string]$BackupDirectory = "D:\chatify-realtime\backup",
    [int]$Keep = 7,
    [switch]$Apply
)

$ErrorActionPreference = "Stop"
if ($Keep -lt 1) { throw "Keep must be at least 1" }
if (-not (Test-Path -LiteralPath $BackupDirectory)) {
    Write-Output "Backup directory does not exist: $BackupDirectory"
    exit 0
}

$dumps = @(Get-ChildItem -LiteralPath $BackupDirectory -File -Filter "chatify-*.dump" | Sort-Object LastWriteTime -Descending)
$stale = @($dumps | Select-Object -Skip $Keep)
if ($stale.Count -eq 0) {
    Write-Output "No local backups to prune; keeping $($dumps.Count) dump(s)."
    exit 0
}

$bytes = ($stale | Measure-Object -Property Length -Sum).Sum
Write-Output ("Candidates: {0} dump(s), {1:N0} bytes; keeping newest {2}." -f $stale.Count, $bytes, $Keep)
foreach ($file in $stale) { Write-Output ("- " + $file.FullName) }
if (-not $Apply) {
    Write-Output "Preview only. Re-run with -Apply to remove these files."
    exit 0
}

foreach ($file in $stale) { Remove-Item -LiteralPath $file.FullName -Force }
Write-Output "Pruned $($stale.Count) local backup dump(s)."
