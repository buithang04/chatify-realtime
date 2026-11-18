# Chatify Realtime — Operations Runbook

## Start and inspect

```powershell
docker compose --project-name chatify-realtime-local --env-file .env.local -f infra/docker/compose.yaml up -d
docker compose --project-name chatify-realtime-local --env-file .env.local -f infra/docker/compose.yaml ps
docker compose --project-name chatify-realtime-local --env-file .env.local -f infra/docker/compose.yaml logs --tail=100 api signaling media-worker outbox-publisher
```

Health endpoints:

- API: `GET http://localhost:8080/health/live` and `/health/ready`
- API requests under `/api` use an atomic Redis-backed per-IP limit (`API_RATE_LIMIT_MAX`, default 300 requests/minute) in the Compose runtime; Redis failures return `503` rather than silently failing open. Unit-only app construction without a Redis address uses the local fallback.
- API request bodies are capped by `API_MAX_BODY_BYTES` (default 1 MiB); attachment bytes must use the signed object-storage flow rather than the API process.
- API JSON/text responses use negotiated gzip/brotli compression. WebRTC media is not re-compressed by the API: browser codecs and mediasoup handle audio/video bitrate and codec compression, while signaling enables per-message deflate.
- Signaling liveness: `GET http://localhost:3001/health`; readiness (including Redpanda chat relay): `GET http://localhost:3001/ready`
- Media: `GET http://localhost:3002/health`
- API metrics: `GET http://localhost:8080/metrics`; expose this endpoint only to the monitoring network in production. It provides bounded route/status RED counters and latency histograms plus readiness-failure count.
- API metrics also expose bounded PostgreSQL pool gauges/counters (`max`, `total`, `acquired`, `idle`, and waited acquisitions); the pool exhaustion alert fires when acquired connections remain at the configured maximum.
- API storage metrics expose operation/error counters without object-key labels; Prometheus alerts on new object-storage errors so upload/download failures are visible.
- Local Prometheus: `http://localhost:9090`; it scrapes `api:8080/metrics` every 15 seconds and loads alert rules from `infra/monitoring/alerts.yml`.
- Monitoring smoke gate: `npm --prefix harness run monitoring` verifies the four targets and required alert rules after startup.
- Complete local release gate: `.\scripts\verify-local.ps1` runs Compose validation, service status, smoke, failure/load, TURN relay, monitoring, and browser E2E; use `-StartStack` only when a rebuild/start is needed.
- Web build endpoints: `WEB_API_URL`, `WEB_SIGNALING_URL`, and `WEB_MEDIA_URL` are injected as `VITE_*` build arguments. Production must set all three to externally reachable HTTPS/WSS endpoints; local defaults intentionally point to loopback ports.
- Web CSP: `WEB_CSP_CONNECT_SRC` is injected into the nginx response policy and must contain the exact `WEB_API_URL`, `WEB_SIGNALING_URL`, `WEB_MEDIA_URL`, and WSS signaling origin. Only explicit HTTPS/WSS origins are allowed; do not use `*`, localhost, or plain HTTP/WS.
- Browser sessions refresh the rotated access token every 10 minutes (access-token TTL is 15 minutes) and update Socket.IO authentication for the next reconnect; transient refresh failures are retried on the next interval.
- Login/register/refresh responses set `Cache-Control: no-store` and `Pragma: no-cache` because they contain access-token material; keep these responses out of browser and intermediary caches.
- Before a production deployment, run `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-production-config.ps1 -EnvFile .\.env.production`; it validates secrets, HTTPS origins, CSP, public media address, TURN, and object-storage settings without printing secret values.
- Local restore drills create ignored dumps under `backup\`; inspect retention with `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\prune-local-backups.ps1 -Keep 7`. The command is preview-only unless `-Apply` is supplied.
- Outbox metrics: the internal `outbox-publisher:8083/metrics` endpoint reports pending events, publish totals, cycle errors, and last successful cycle; Prometheus alerts on target failure or a sustained backlog above 100 events.
- Signaling metrics: `http://localhost:3001/metrics`; media metrics: `http://localhost:3002/metrics`. Prometheus monitors both process availability and basic realtime resource gauges.
- API requests return `X-Request-ID`; clients may supply a safe ID up to 128 characters, otherwise the API generates one. Do not put tokens or personal data in this header.
- Media transport cleanup: clients must call `POST /transports/:transportID/close` for owned transports during room teardown; investigate repeated `no more available ports` errors as a lifecycle leak. Media metrics expose ICE/DTLS failure counters and Prometheus raises `ChatifyMediaICEFailures` so TURN/network regressions are visible before they become user reports.
- ICE/TURN: `RTC_STUN_URL`, `RTC_TURN_URL`, `RTC_TURN_USERNAME`, and `RTC_TURN_CREDENTIAL` are injected into media transport responses. Local defaults target `127.0.0.1`; production must use a public TURN address and short-lived REST credentials rather than the local static credential.
- Local TURN allocation/relay drill: `.\scripts\turn-udp-drill.ps1` uses a non-loopback container peer and verifies two-way UDP with zero packet loss in the local network. Production must repeat this from an external network; do not enable loopback peers as a workaround.
- Compose coturn health is based on a real UDP STUN binding request; media-worker waits for that health signal before starting.
- Signaling security: directed `signal.to` messages are rejected with `TARGET_NOT_IN_ROOM` unless the target socket is currently joined to the same room.
- Internal media-policy calls require `INTERNAL_SERVICE_TOKEN` plus the end-user JWT; keep this token in the secret manager and do not expose it to the browser. Local signaling/media HTTP ports are loopback-bound by Compose.
- Room modes: the web 1-to-1 option persists as a `group` room with `maxParticipants=2`, preserving the existing database/API contract while enforcing two-person capacity transactionally.
- RustFS: `http://localhost:9001`

Production configuration:

- Copy `.env.production.example` into the deployment secret/config workflow; it contains placeholders only and must not be committed with real credentials.
- Set `APP_ENV=production`. The API refuses to start when JWT, refresh-cookie, CORS, public object-storage HTTPS, database, or object-storage credential requirements are unsafe or missing.
- Keep `/metrics` and the media control plane on private monitoring/internal networks; production TLS, ingress allowlists, public TURN, and notification routing remain deployment responsibilities.
- Signaling/media also fail fast under `APP_ENV=production` unless JWT/service credentials, explicit CORS, public `RTC_ANNOUNCED_ADDRESS`, and TURN URL/credentials are configured.

## Database and migration safety

Migrations run through the one-shot `migrate` service and are recorded in `schema_migrations`. Before a production migration, take a PostgreSQL backup and verify the backup can be listed/restored in an isolated database.

```powershell
docker exec chatify-realtime-local-postgres-1 pg_dump -U chatify -d chatify -Fc -f /tmp/chatify.dump
docker cp chatify-realtime-local-postgres-1:/tmp/chatify.dump .\backup\chatify.dump
```

Repeatable local backup/restore drill:

```powershell
.\scripts\backup-restore-drill.ps1
```

The script writes a timestamped custom-format dump under `backup/`, restores it into a temporary isolated database, verifies the migration table, then removes only that temporary database.

The drill validates the temporary database identifier and passes `psql`/`pg_restore` arguments directly to avoid shell-quoting ambiguity on Windows PowerShell.

Never use `docker compose down -v` for routine maintenance; it removes local database, broker, and object-storage volumes.

## Object storage

Uploads use short-lived signed POST policies. The API creates an attachment intent, limits content type and exact size, and requires a completion call that stats the object before `ready`.

- Ready attachments are downloaded through `GET /api/v1/uploads/:attachmentID/download`; the API requires an active room membership and returns a short-lived signed GET URL. The object-storage bucket remains private.

- Keep RustFS credentials outside source control.
- Keep the bucket private; distribute objects through authenticated application download policies when that feature is added.
- Remove rejected or abandoned pending objects with a scheduled cleanup job after the retention window.
- Local Compose runs `attachment-cleanup` every 15 minutes with a 24-hour pending retention default; if object deletion fails, the database row stays pending for a later retry.
- Keep the S3 endpoint used for signing separate from the browser-facing endpoint.

## Realtime and media

- Chat messages are persisted by the API, published through the transactional outbox, and relayed from Redpanda to Socket.IO. A `503` from signaling `/ready` means the chat relay is not connected; inspect `docker compose ... logs --tail=100 signaling outbox-publisher redpanda` before restarting.
- A signaling restart intentionally does not replay historical chat events to newly connected clients; clients load history through the authenticated API message endpoint and receive only live events from the relay startup boundary.
- The signaling gateway is currently single-instance for in-memory sequence/deduplication state.
- Compose enables both the Redis Socket.IO adapter and Redis-backed atomic signal sequence/deduplication. Signal event claims use a short TTL so abandoned event keys do not grow without bound.
- Keep the mediasoup HTTP control plane private to the internal network; it is not an end-user API.
- Keep the configured UDP range open on every media node and set the announced address to the node's reachable public address in deployment.
- Monitor worker death, transport creation failures, ICE failure rate, and bitrate changes.
- Media transport lifecycle: unconnected transports expire after `MEDIA_TRANSPORT_IDLE_TIMEOUT_MS` (default 60 seconds); ICE-disconnected transports are cleaned after a 5-second grace period. Repeated browser/session churn should not exhaust the configured UDP range.

## Incident response

1. Check `health/ready` and Compose service status.
2. Inspect API, signaling, media, and outbox logs for the incident window.
3. If a single service is unhealthy, restart only that service and preserve volumes.
4. If a migration failed, stop API/outbox, fix the migration or dependency, and rerun the one-shot migration service.
5. If data integrity is suspected, stop writes, preserve logs, take a fresh database/object-storage snapshot, then restore into an isolated environment before remediation.

## Docker Desktop disk pressure

Keep several GB free on the Windows system drive. Docker Desktop's WSL2 data disk needs temporary space for image builds and upgrades. If it cannot start, inspect `docker desktop logs --boot 0 --priority 2 --no-color`, then run `wsl.exe --shutdown` and restart Docker Desktop. Do not delete Compose volumes as a disk-space shortcut.
