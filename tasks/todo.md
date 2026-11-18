# Executable Task List

## Phase 7 — Social, profile and private rooms

- [x] **T7.1: Friends and friend-room suggestions** — request by email, accept/reject/remove, mutual friend list, suggest only active rooms with friends; integration and two-browser verification.
- [x] **T7.2: Locked rooms** — owner sets or removes a password; nonmembers need it to join; active F5 reconnect remains authorized; hash is never returned; API security tests.
- [x] **T7.3: Profile and friend messages** — change display name/avatar; send persisted private messages to friends outside a room with realtime delivery and recipient-only access; integration and browser tests.

## Phase 0 — Infrastructure

- [x] **T0.1: Create isolated Docker infrastructure**
  - Evidence: `docker compose ps` shows PostgreSQL, Redis, Redpanda, RustFS, Redpanda Console, and coturn running.
  - Files: `infra/docker/compose.yaml`, `.env.example`, `README.md`.

## Phase 1 — API foundation

- [x] **T1.1: Create Go API skeleton**
  - Depends on: T0.1.
  - Acceptance: `GET /health/live` returns 200; `GET /health/ready` returns dependency status; graceful shutdown works.
  - Verification: Go unit tests pass in `golang:1.24-alpine`; Docker build is verified by T1.4 after the Dockerfile is added.

- [x] **T1.2: Add PostgreSQL migration runner and schema base**
  - Depends on: T1.1.
  - Acceptance: migrations run reproducibly against the Compose PostgreSQL service; no migration runs twice.
  - Verification: migration runner succeeded twice; `schema_migrations` contains 1 row and the three base tables exist.

- [x] **T1.3: Add Redis and Redpanda clients**
  - Depends on: T1.1.
  - Acceptance: readiness checks connect using Docker service names; timeout and failure states are reported without leaking secrets.
  - Verification: Go tests pass; live API smoke test returned 200/ready with all three dependency checks `ok` on the Compose network.

- [x] **T1.4: Add API Dockerfile and Compose service**
  - Depends on: T1.1, T1.2, T1.3.
  - Acceptance: API starts with `docker compose up -d`; health check becomes healthy.
  - Verification: Compose build/up succeeded; API container healthy; live and ready curl smoke tests returned 200.

### Checkpoint 1

- [x] API foundation is healthy in Docker.
- [x] Focused tests pass.
- [x] No secrets are tracked.

## Phase 2 — Identity and rooms

- [x] **T2.1: Implement users and password authentication**
- [x] **T2.2: Implement sessions and refresh-token rotation**
- [x] **T2.3: Implement rooms and transactional membership**
- [x] **T2.4: Add race/idempotency tests for join and leave**
- [x] **T2.5: Implement transactional outbox publisher**

## Phase 3 — Signaling

- [x] **T3.1: Create Socket.IO gateway**
- [x] **T3.2: Add socket authentication and room authorization**
- [x] **T3.3: Add heartbeat, reconnect, ordering, and duplicate-event handling**

## Phase 4 — Media

- [x] **T4.1: Create mediasoup service and worker**
- [x] **T4.2: Implement publish/subscribe audio and video**
- [x] **T4.3: Add adaptive bitrate, simulcast, mute, camera, and screen share**
- [x] **T4.4: Add group-call and livestream roles**
  - Evidence: room mode is persisted as `group` or `livestream`; API media policy grants group members publish/consume, while livestream participants consume only and owner/moderator can publish.
  - Verification: migration version 5 applied; Go and Socket.IO tests passed; live owner/participant policy smoke test returned the expected permissions.

## Phase 5 — Chat and files

- [x] **T5.1: Implement idempotent text chat**
  - Evidence: `POST /api/v1/rooms/:roomID/messages` validates bounded text, requires active membership, deduplicates by `(roomId, senderId, clientMessageId)`, and emits a transactional outbox event only on first insert.
  - Verification: Go quality gates passed; live duplicate submission returned the same message ID and exactly one `chat.message.created` outbox row.
- [x] **T5.2: Implement signed RustFS upload URLs**
  - Evidence: active room members receive a 10-minute signed POST policy with exact content type and exact requested size, bounded to 25 MiB; object keys are server-generated and scoped by room/user.
  - Verification: API startup ensured the bucket exists; live curl multipart upload completed successfully against RustFS.
- [x] **T5.3: Validate and authorize file/image attachments**
  - Evidence: attachment intent is scoped to an active room member/uploader; only allowlisted MIME types and exact sizes are accepted; complete re-stats RustFS before `ready`.
  - Verification: Go test/vet passed; live upload completed as `ready`, disallowed executable MIME returned 422, and migrations reached version 7.

## Phase 6 — Verification and hardening

- [x] **T6.1: Add end-to-end API/signaling/media smoke harness**
  - Evidence: `harness/smoke.cjs` checks API live/ready, authenticated room creation, idempotent message retry, Socket.IO room policy, and media router creation.
  - Verification: passed from host and from the Compose network after Docker recovery.
- [x] **T6.2: Add failure and load tests for realtime paths**
  - Evidence: `harness/failure-load.cjs` tests 20 concurrent idempotent message retries, room-capacity race, invalid Socket.IO token, rejected MIME, and invalid media bitrate.
  - Verification: live harness passed with one successful capacity join, three 409 rejections, and all invalid-input assertions.
- [x] **T6.3: Add operational runbook and launch checklist**
  - Evidence: `docs/OPERATIONS.md` documents start/health, backup/migration, object storage, realtime/media operations, incident response, and disk recovery; `docs/LAUNCH_CHECKLIST.md` records production gates and remaining hardening.
  - Verification: local stack healthy; both smoke and failure/load harnesses passed after Docker recovery.

- [x] **T6.4: Add browser E2E for room chat and remote media**
  - Depends on: T4.2, T5.1, T6.1.
  - Acceptance: two isolated browser contexts can authenticate, create/join the same room, exchange chat, and render a remote camera tile using a fake media device.
  - Verification: `harness/npm run browser-e2e` passed with no page errors; Chromium is stored outside source under `.cache/`.

- [x] **T6.5: Add API request-rate hardening**
  - Depends on: T1.1, T2.1.
  - Acceptance: API routes have a bounded configurable per-IP request budget and return a machine-readable 429 with `Retry-After` when exceeded.
  - Verification: Go test/vet passed; focused rate-limit test passed; deployed smoke, failure/load, and browser E2E harnesses passed.

- [x] **T6.6: Close WebRTC transports explicitly**
  - Depends on: T4.2, T6.2.
  - Acceptance: clients can close owned transports through an authenticated endpoint, and repeated test/session churn does not exhaust the bounded RTP port range.
  - Verification: media tests passed; media/web images redeployed; failure/load passed after repeated runs without UDP port exhaustion; browser E2E passed.

- [x] **T6.7: Wire STUN/TURN settings into mediasoup clients**
  - Depends on: T4.1, T4.2, T0.1.
  - Acceptance: media transport responses include configured ICE servers; client send/receive transports pass them into `mediasoup-client`; local Compose exposes STUN/TURN settings without hardcoding them in source.
  - Verification: media tests passed 4/4; Compose config passed; smoke asserted a TURN server was returned; failure/load and browser E2E passed.

- [x] **T6.8: Add reproducible CI quality gates**
  - Depends on: T6.1, T6.2, T6.4.
  - Acceptance: every push/PR runs service builds, tests, audits, Compose validation, smoke/failure-load, and browser E2E without production secrets.
  - Verification: `.github/workflows/ci.yml` and Dependabot configuration added; commands mirror locally passing gates.

- [x] **T6.9: Enforce same-room signaling targets**
  - Depends on: T3.2, T3.3.
  - Acceptance: directed signals are accepted only when the target socket is currently in the same authorized room.
  - Verification: signaling tests passed 6/6, including `TARGET_NOT_IN_ROOM`; deployed smoke and failure/load passed.

- [x] **T6.10: Apply measured media bitrate controls**
  - Depends on: T4.3, T6.4.
  - Acceptance: camera uses bounded simulcast layers, screen share has a bounded bitrate, and the server-side transport cap is applied without increasing the web bundle materially.
  - Verification: web bundle remained 118.37 kB gzip before the small 1-to-1 UI addition; web build, smoke, failure/load, and browser E2E passed; values documented in `docs/PERFORMANCE.md`.

- [x] **T6.11: Expose first-class 1-to-1 room creation**
  - Depends on: T2.3, T4.4, T6.4.
  - Acceptance: web UI offers a 1-to-1 room mode, creates it with capacity two, and renders a distinct 1-1 room label while reusing the tested group media policy.
  - Verification: web build passed; browser E2E selected the 1-1 mode and rendered `1-1 CALL`; smoke and failure/load passed.

- [x] **T6.12: Browser-verify livestream roles**
  - Depends on: T4.4, T6.4.
  - Acceptance: livestream owner can publish media while a viewer can consume it but cannot publish camera/microphone.
  - Verification: Playwright browser E2E passed with owner publish, viewer `Chỉ xem`, disabled viewer camera control, and remote video rendering.

- [x] **T6.13: Clean anonymous refresh bootstrap**
  - Depends on: T1.2, T6.4.
  - Acceptance: a fresh browser without a refresh cookie receives no-content instead of a validation error, and the frontend does not attempt to use an absent token.
  - Verification: API/web redeployed; smoke, failure/load, and browser E2E passed.

- [x] **T6.14: Authorize attachment downloads**
  - Depends on: T5.2, T5.3.
  - Acceptance: only active members can obtain a short-lived download URL for a `ready` attachment; pending/rejected or cross-room attachments are not disclosed.
  - Verification: API Go test/vet passed; smoke passed with `attachmentDownload=true`; API image build and live failure/load verification passed after deployment.

- [x] **T6.15: Clean abandoned attachment uploads**
  - Depends on: T5.2, T5.3, T6.14.
  - Acceptance: a restartable cleanup worker deletes objects for stale pending records, marks them rejected only after deletion succeeds, and retries failures safely.
  - Verification: cleanup binary built in the API image; Compose config validated; worker started locally; smoke and failure/load passed.

- [x] **T6.16: Rehearse PostgreSQL backup and restore**
  - Depends on: T1.3, T6.1.
  - Acceptance: a repeatable script creates a custom-format backup, restores it into an isolated temporary database, verifies the schema, and removes only the temporary database.
  - Verification: `scripts/backup-restore-drill.ps1` passed locally; restored migration count was `7`.

- [x] **T6.17: Add API observability foundation**
  - Depends on: T1.2, T6.5.
  - Acceptance: API emits a bounded request ID, exposes route/status RED counters with latency histograms, and counts readiness failures without logging credentials or user data.
  - Verification: observability unit tests, Go test/vet, smoke (`requestId=true,metrics=true`), failure/load, and browser E2E passed.

- [x] **T6.18: Add local Prometheus monitoring**
  - Depends on: T6.17, T6.8.
  - Acceptance: Compose starts Prometheus, scrapes API metrics, loads bounded alert rules for API availability/readiness/5xx rate, and exposes a local query endpoint.
  - Verification: Compose config passed; Prometheus target is `up`; all three alert rules loaded; smoke/failure-load/browser E2E passed.

- [x] **T6.19: Harden media transport lifecycle against browser churn**
  - Depends on: T4.2, T6.6.
  - Acceptance: unconnected and ICE-disconnected transports are automatically reclaimed, preventing the bounded UDP range from being exhausted when a browser closes unexpectedly.
  - Verification: media build passed; media tests passed 5/5; browser E2E passed three consecutive runs after media redeploy.

- [x] **T6.20: Monitor signaling and media service availability**
  - Depends on: T6.17, T6.18.
  - Acceptance: signaling and media expose internal metrics endpoints, Prometheus scrapes both targets, and target-down alerts are loaded for each realtime service.
  - Verification: signaling tests passed 6/6 in the build stage; media tests passed 5/5; both metrics endpoints returned 200; all three Prometheus targets were `up`; smoke/failure-load/browser E2E passed.

- [x] **T6.21: Gate monitoring in CI**
  - Depends on: T6.18, T6.20.
  - Acceptance: a repeatable harness fails if API/signaling/media Prometheus targets are not `up` or required alert rules are missing.
  - Verification: `npm --prefix harness run monitoring` passed locally with three targets `up` and five alert rules loaded; CI workflow invokes the same command.

- [x] **T6.22: Enable Redis Socket.IO adapter**
  - Depends on: T3.1, T6.20.
  - Acceptance: signaling uses Redis pub/sub plus Redis-backed atomic signal sequence/deduplication when configured, Compose injects Redis credentials and waits for Redis health, and shutdown closes clients.
  - Verification: signaling build-stage tests passed 6/6; dependency audit reported 0 vulnerabilities; signaling redeploy and relay readiness verification passed.

- [x] **T6.23: Move directed signal ordering state to Redis**
  - Depends on: T6.22.
  - Acceptance: signal event claims use atomic Redis state with bounded TTL, duplicate events return their original sequence, and Redis state failures are explicit instead of silently falling back to inconsistent local ordering.
  - Verification: local-state regression test added; signaling build-stage tests and audit passed; Compose Redis-backed startup verified; smoke/failure-load/browser E2E passed.

- [x] **T6.24: Expand failure/load coverage**
  - Depends on: T6.6, T6.19, T6.23.
  - Acceptance: failure/load verification covers reconnect/rejoin, concurrent idempotent retries, room-capacity race, authorization failures, and more transport churn cycles than the bounded local UDP range.
  - Verification: `harness/failure-load.cjs` passed with `reconnectRejoin=true` and `mediaTransportChurn=30`.

- [x] **T6.26: Enforce API request body limits**
  - Depends on: T6.25.
  - Acceptance: API rejects request bodies over the configured `API_MAX_BODY_BYTES` limit while direct object-storage uploads remain the attachment path; local default is 1 MiB.
  - Verification: request-limit regression test, Go tests/vet, Compose config validation, API redeploy, and smoke all passed.

- [x] **T6.27: Authenticate internal media-policy calls**
  - Depends on: T6.23, T6.25.
  - Acceptance: API internal room-policy endpoints require a constant-time-checked service token in addition to the user JWT; signaling and media send the token; local control ports remain loopback-bound.
  - Verification: production config test requires the token; API/signaling/media builds passed; all three services became healthy; smoke, failure-load, monitoring, and browser E2E passed.

- [x] **T6.28: Instrument and alert the outbox publisher**
  - Depends on: T6.21, T6.24.
  - Acceptance: outbox exposes health and Prometheus metrics for pending events, successful publishes, errors, and last successful cycle; Prometheus scrapes it and alerts on unreachable/high backlog.
  - Verification: Go tests/vet, Compose validation, outbox healthcheck, live metrics (`pending_events=0`, `errors=0`), and monitoring gate passed with four targets and seven alert rules.

- [x] **T6.29: Make backup/restore drill shell-safe**
  - Depends on: T6.28.
  - Acceptance: restore database names are validated as safe identifiers and `psql/pg_restore` receive arguments directly without fragile nested shell quoting; only the isolated drill database is removed.
  - Verification: `scripts/backup-restore-drill.ps1` passed with migration count `7` and restore database `chatify_rollback_rehearsal`.

- [x] **T6.30: Instrument PostgreSQL pool health**
  - Depends on: T6.17, T6.28.
  - Acceptance: API metrics expose bounded PostgreSQL pool gauges/counters and Prometheus alerts when acquired connections remain at the configured maximum.
  - Verification: Go tests/vet, API redeploy, live metrics (`max_conns=12`, `acquired_conns=0`, `idle_conns=1`), monitoring passed with four targets/eight alert rules, smoke/failure-load/browser E2E passed.

- [x] **T6.31: Instrument object-storage failures**
  - Depends on: T6.6, T6.30.
  - Acceptance: API exports object-storage operation/error counters without object-key labels and Prometheus alerts on new storage errors.
  - Verification: Go tests/vet, API redeploy, smoke upload/download, live metrics (`operations=4`, `errors=0`), and monitoring passed with four targets/nine alert rules.

- [x] **T6.32: Compress API responses at the protocol layer**
  - Depends on: T6.6.
  - Acceptance: API negotiates gzip/brotli for responses above the middleware threshold; WebRTC media remains codec-compressed and is not buffered/recompressed by the API; signaling keeps per-message deflate.
  - Verification: compression regression test, Go tests/vet, API redeploy, and smoke passed.

- [x] **T6.33: Add repeatable local TURN UDP relay drill**
  - Depends on: T4.2, T6.19.
  - Acceptance: local drill performs authenticated TURN allocation and two-way UDP relay through a non-loopback peer; it does not weaken coturn loopback policy.
  - Verification: `scripts/turn-udp-drill.ps1` passed with zero packet loss; external-network TURN verification remains required for production.

- [x] **T6.34: Move API rate limiting to Redis**
  - Depends on: T6.22, T6.30.
  - Acceptance: Compose runtime uses an atomic Redis Lua counter with bounded TTL and returns `503 RATE_LIMIT_UNAVAILABLE` instead of silently failing open; unit-test apps without Redis retain the local fallback.
  - Verification: Go tests/vet, API redeploy, smoke/failure-load passed, and Redis contained shared `chatify:rate-limit:api:*` counters.

- [x] **T6.35: Fail fast on unsafe signaling/media production config**
  - Depends on: T6.27, T6.33.
  - Acceptance: production signaling/media require strong JWT and service credentials, explicit CORS, public media announced address, and explicit TURN configuration; local defaults remain valid.
  - Verification: signaling tests passed 8/8; media tests passed 7/7 with audit clean; Compose validation, service redeploy, smoke, browser E2E, and monitoring passed.

- [x] **T6.36: Add real coturn healthcheck**
  - Depends on: T6.33.
  - Acceptance: Compose runs `turnutils_stunclient` against the local coturn UDP listener and media waits for coturn health before startup; no loopback-peer relaxation is introduced.
  - Verification: Compose validation, coturn health became healthy, media remained healthy, and smoke passed.

- [x] **T6.37: Consolidate local release verification**
  - Depends on: T6.33, T6.36.
  - Acceptance: one PowerShell gate runs Compose validation/status, smoke, failure/load, TURN UDP drill, Prometheus monitoring, and browser E2E; rebuilding is opt-in via `-StartStack`.
  - Verification: `.\scripts\verify-local.ps1` passed all stages, including browser E2E.

- [x] **T6.25: Fail fast on unsafe production API configuration**
  - Depends on: T6.16, T6.23.
  - Acceptance: `APP_ENV=production` rejects weak JWT secrets, insecure refresh cookies, wildcard CORS, non-HTTPS public object storage URLs, or missing database/object-storage credentials; local defaults remain valid.
  - Verification: Go tests and vet passed; API image rebuilt and redeployed; smoke, failure/load, monitoring, and browser E2E all passed; `.env.production.example` documents the secret-manager contract.

- [x] **T6.38: Alert on media ICE/DTLS failures**
  - Depends on: T6.37.
  - Acceptance: media exports bounded ICE/DTLS failure counters and Prometheus alerts when either counter increases; monitoring verification checks the rule.
  - Verification: media tests/build, Compose redeploy, monitoring, smoke, failure/load, and browser E2E passed.

- [x] **T6.39: Parameterize browser media endpoint**
  - Depends on: T6.37.
  - Acceptance: the web image receives API, signaling, and media endpoints as build arguments; production examples document externally reachable values instead of silently defaulting media to localhost.
  - Verification: Compose config, web image build, browser E2E, and local release gate passed.

- [x] **T6.40: Parameterize web CSP endpoints**
  - Depends on: T6.39.
  - Acceptance: nginx CSP allows only explicitly configured API/signaling/media origins; production no longer inherits localhost-only connect sources.
  - Verification: Compose config, web image build, response-header inspection, browser E2E, and local release gate passed.

- [x] **T6.41: Refresh browser access sessions**
  - Depends on: T2.2, T6.39.
  - Acceptance: the browser refreshes the rotating access token before the 15-minute TTL expires and updates Socket.IO auth without interrupting transient network failures.
  - Verification: web TypeScript/build, smoke, and browser E2E passed.

- [x] **T6.42: Add production configuration lint**
  - Depends on: T6.25, T6.35, T6.40.
  - Acceptance: a non-mutating preflight rejects placeholder secrets, non-HTTPS public endpoints, wildcard/local CSP, local media address, and missing TURN/object-storage settings without logging secret values.
  - Verification: production example is rejected with actionable errors; local release gate remains green.

- [x] **T6.43: Cross-check production CSP endpoints**
  - Depends on: T6.40, T6.42.
  - Acceptance: production preflight rejects CSP endpoint drift and missing WSS signaling origin.
  - Verification: production example parsing and local Compose validation passed.

- [x] **T6.44: Make backup drill non-destructive**
  - Depends on: T6.29.
  - Acceptance: restore drill refuses an existing temporary database and only cleans up a database created by its current run.
  - Verification: backup/restore drill passed with migration verification and cleanup.

- [x] **T6.45: Prevent auth response caching**
  - Depends on: T2.2.
  - Acceptance: responses that issue or rotate tokens send `Cache-Control: no-store` and `Pragma: no-cache`.
  - Verification: Go tests/vet, API rebuild, smoke, and browser E2E passed.

- [x] **T6.46: Assert auth cache headers in smoke**
  - Depends on: T6.45.
  - Acceptance: smoke fails if register/login responses containing token material omit `Cache-Control: no-store`.
  - Verification: API Docker test/build, API redeploy, and smoke assertion passed.

- [x] **T6.47: Add safe local backup retention tool**
  - Depends on: T6.44.
  - Acceptance: backup pruning defaults to preview, keeps a configurable newest-N set, and requires explicit `-Apply` before deletion.
  - Verification: script syntax/preview behavior inspected; no backup files are deleted implicitly.

- [x] **T6.48: Add room ID copy affordance**
  - Depends on: T4.4.
  - Acceptance: active room exposes an accessible copy action with clipboard fallback and transient success feedback.
  - Verification: web build, smoke, and browser E2E passed.

- [x] **T6.49: Add explicit leave-room action**
  - Depends on: T4.4.
  - Acceptance: active room exposes an accessible leave action that uses the existing socket/media cleanup and membership removal flow.
  - Verification: web build, smoke, failure/load, and browser E2E passed.

- [x] **T6.50: Fix browser E2E page-error capture**
  - Depends on: T6.37.
  - Acceptance: uncaught page errors are recorded in the shared diagnostics object instead of throwing from the listener.
  - Verification: Browser E2E passed with the corrected listener.

- [x] **T6.51: Cover room sharing and leaving in Browser E2E**
  - Depends on: T6.48, T6.49.
  - Acceptance: browser regression test verifies copy feedback and that leaving a room returns to the empty workspace before the livestream flow.
  - Verification: Browser E2E passed.
