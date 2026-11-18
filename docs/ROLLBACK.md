# Chatify Realtime — Rollback Runbook

## Application rollback

1. Stop new traffic at the ingress and record the deployment image tags, migration version, and current health/metrics output.
2. Roll back API, web, signaling, and media images to the last known-good immutable tags. Keep the current database schema unless the release notes explicitly prove it is backward-compatible with the rollback candidate.
3. Restart only the affected application services, wait for health checks, then run `harness/smoke.cjs` and inspect Prometheus targets before reopening traffic.
4. If the rollback candidate cannot read the current schema, stop and use database restore/cutover below; do not drop columns or tables on the live database.

## Database restore/cutover rehearsal

The migration runner is forward-only by design. A migration rollback means restoring a tested PostgreSQL backup into an isolated database or a replacement instance, validating the target application against it, and then performing a controlled cutover. Never run an ad-hoc `DROP COLUMN` or edit `schema_migrations` on the live database.

Run the local restore drill:

```powershell
.\scripts\backup-restore-drill.ps1
```

Before production release, retain a pre-migration backup and rehearse this sequence in staging:

1. Restore the pre-migration backup to an isolated PostgreSQL instance.
2. Point the rollback image at the restored instance using a temporary deployment configuration.
3. Run readiness, smoke, and representative read/write checks.
4. Promote the replacement instance only after application and data checks pass; preserve the failed instance for forensic recovery.

## Release evidence

Record immutable image digests, backup object IDs, migration versions, health output, and the operator/time for every rollback. The local backup drill writes its temporary dump under the ignored `backup/` directory, refuses to overwrite an existing restore database, and drops only the isolated database created by that run.
