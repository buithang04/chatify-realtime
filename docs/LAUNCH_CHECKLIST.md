# Chatify Realtime — Launch Checklist

## Required before production

- [ ] Replace all local placeholder secrets with a secret manager.
- [x] API production mode fails fast on unsafe security configuration; `.env.production.example` documents the required secret/config contract.
- [ ] Set `COOKIE_SECURE=true` behind HTTPS and configure an explicit production CORS origin.
- [ ] Use a managed PostgreSQL/Redis/Redpanda/RustFS setup or durable volumes with tested backups.
- [ ] Configure TLS termination, rate limits, request size limits, and an allowlisted ingress policy.
- [x] API rate limiting is Redis-backed and atomic in the Compose runtime; production ingress still needs its own global policy and allowlist.
- [x] API has a configurable 1 MiB request-body limit; production ingress must still enforce its own request-size and allowlist policy.
- [x] API internal media-policy calls require service authentication and local media/signaling control ports are loopback-bound; production network policy is still required.
- [ ] Configure a public TURN address/credentials and verify UDP relay from an external network.
- [x] Local authenticated TURN allocation/relay drill passes; public address and external-network verification remain required.
- [x] Local coturn UDP STUN healthcheck is enforced before media startup.
- [ ] Set `RTC_ANNOUNCED_ADDRESS` to the public media-node address; verify the complete UDP range.
- [x] Signaling/media production startup validation rejects missing credentials, wildcard CORS, local announced addresses, and missing TURN settings.
- [x] Add shared Socket.IO adapter and Redis-backed signal sequence/deduplication before running more than one signaling instance.
- [x] Add a scheduled cleanup job for rejected/abandoned uploads.

## Verification gates

- [x] CI workflow validates service builds, tests, audits, Compose config, smoke, failure/load, and browser E2E on PR/push.
- [ ] `docker compose ... ps` shows all required services healthy.
- [ ] `node harness/smoke.cjs` passes from the deployment network.
- [ ] `node harness/failure-load.cjs` passes in staging.
- [x] PostgreSQL backup and restore drill passes locally with `scripts/backup-restore-drill.ps1`.
- [x] Failure/load harness covers concurrent joins, reconnect/rejoin, message retries, and 30 media transport churn cycles locally; staging-scale load remains deployment-specific.
- [x] Alerts exist for readiness failures, database pool exhaustion, outbox backlog, media worker death, ICE/DTLS (TURN/network) failures, and object-storage errors.
- [x] API PostgreSQL pool, outbox backlog/error, object-storage error, and media ICE/DTLS failure metrics/alerts are implemented; production notification routing remains deployment work.
- [x] Outbox publisher exposes backlog/error metrics and Prometheus alerts; production notification routing remains deployment work.
- [x] API request ID and Prometheus-compatible RED metrics are available for local verification; production dashboard/alerts still need wiring.
- [x] Local Prometheus scrapes the API target and loads page/ticket alert rules; production notification routing remains environment-specific.
- [x] Local Prometheus also scrapes signaling and media targets and alerts when either realtime service is unreachable.
- [ ] Rollback image/tag and migration rollback procedure are documented and rehearsed.

Rollback procedure is documented in [`docs/ROLLBACK.md`](ROLLBACK.md); production image/tag and staging cutover rehearsal remain required before launch.

## Local release evidence

The repository's local evidence is recorded in `harness/build-log.md`. Keep this file aligned with the exact image tags, migration version, test commands, and runtime smoke outputs used for each release candidate.
