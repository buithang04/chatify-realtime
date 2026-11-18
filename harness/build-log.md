# Build Log

## 2026-11-03 — Infrastructure checkpoint

- Docker Engine: 29.9.2.
- Docker Compose: v5.6.1.
- Compose project: `chatify-realtime-local`.
- Verified running services: PostgreSQL, Redis, Redpanda, Redpanda Console, RustFS, coturn.
- Verified HTTP smoke checks: RustFS health returned 200; Redpanda Console returned 200.
- Changes made during bootstrap: replaced unavailable MinIO image with RustFS; corrected Redpanda healthcheck; corrected coturn flags.

## 2026-11-03 — Codex runner verification

- `tools/run-next-task.ps1` invoked `codex exec` and passed the repository prompt correctly.
- The Codex session stopped before task execution with `workspace routing discovery failed` while contacting the Codex service.
- No task was marked complete and no application source was changed by this attempt.
- The runner was corrected to use the current `codex exec` option model; automatic review is opt-in via `-AutomaticReview`.
- `codex doctor` confirms authentication/state databases are healthy, but DNS cannot resolve the ChatGPT inference endpoint; this is the current external blocker for actual task execution.
- A subsequent runner check exposed and fixed an option conflict: `--approve-for-me` cannot be combined with `--sandbox`; the wrapper now selects exactly one mode.

## 2026-11-03 — T1.1 API skeleton

- Added `apps/api` Go module using Fiber.
- Added `GET /health/live`.
- Added `GET /health/ready` with TCP dependency checks for PostgreSQL, Redis, and Redpanda.
- Added graceful shutdown on interrupt/SIGTERM.
- Verification command: `docker run --rm -v D:\chatify-realtime\apps\api:/src -w /src golang:1.24-alpine sh -c "gofmt -w *.go && go test ./..."`.
- Verification result: `ok chatify-realtime/api 0.031s`.
- T1.1 marked complete; Docker image/build remains explicitly assigned to T1.4.

## 2026-11-03 — T1.2 PostgreSQL migrations

- Added embedded migration runner at `apps/api/internal/migration`.
- Added `0001_initial.sql` for `users`, `rooms`, and `room_members` plus indexes/constraints.
- Added `cmd/migrate` using pgx and transactional version recording.
- Verification: runner completed twice against the live `chatify-realtime-local` PostgreSQL container.
- Database evidence: `schema_migrations` count = 1; base table count = 3 after the second run.
- T1.2 marked complete.

## 2026-11-03 — T1.3 dependency clients

- Added PostgreSQL `pgxpool`, Redis `go-redis`, and Redpanda/Kafka `kafka-go` readiness clients.
- Readiness checks now use actual protocol-level checks: PostgreSQL `Ping`, Redis `PING`, and Redpanda TCP dial; responses expose only `ok`/`failed`.
- Added injected readiness checks for deterministic API tests.
- Verification command: `docker run --rm -v D:\chatify-realtime\apps\api:/src -w /src golang:1.24-alpine sh -c "go mod tidy && gofmt -w *.go cmd/migrate/*.go internal/migration/*.go && go test ./..."`.
- Verification result: API and migration packages passed.
- Live smoke test on `chatify-realtime-local-net`: `/health/live` returned 200 and `/health/ready` returned 200 with PostgreSQL, Redis, and Redpanda all `ok`.
- T1.3 marked complete.

## 2026-11-03 — T1.4 API container and Compose integration

- Added multi-stage `apps/api/Dockerfile` producing separate API and migration binaries.
- Added Compose `migrate` one-shot service and `api` service with dependency ordering, environment wiring, port 8080, and readiness healthcheck.
- Verification: `docker compose ... up -d --build api` completed successfully.
- Live smoke tests: `GET http://localhost:8080/health/live` returned 200; `GET http://localhost:8080/health/ready` returned 200 with all dependency checks `ok`.
- Compose status: API `Up (healthy)`; PostgreSQL, Redis, and Redpanda also healthy.
- Checkpoint 1 marked complete.

## 2026-11-03 — T2.1 users and password authentication

- Added `0002_auth_passwords.sql` to require a password hash for users.
- Added registration/login contract under `/api/v1/auth/register` and `/api/v1/auth/login`.
- Added boundary validation, email normalization, generic invalid-credential errors, duplicate-email conflict handling, and public-user response allowlisting.
- Passwords are hashed with bcrypt cost 12; plaintext and password hashes are never returned.
- Unit/contract verification: `go test ./...` passed in `golang:1.24-alpine`.
- Live verification against Compose PostgreSQL: register returned 201, duplicate register 409, valid login 200, invalid password 401.
- T2.1 marked complete. Sessions/tokens remain intentionally scoped to T2.2.

## 2026-11-03 — T2.2 sessions and refresh-token rotation

- Added `0003_sessions.sql` with hashed refresh-token storage, expiry, revocation, and replacement lineage.
- Login now issues a 15-minute HS256 access JWT and a 30-day opaque refresh token when `JWT_SECRET` is configured.
- Refresh tokens are delivered only through an `HttpOnly`, `SameSite=Lax` cookie scoped to `/api/v1/auth`; JSON responses expose no refresh token.
- Added `POST /api/v1/auth/refresh`; rotation locks the old session row, inserts the replacement, revokes the old token, and rejects reuse with 401.
- Refresh tokens are stored only as SHA-256 hashes; the raw token is returned only at issuance.
- Verification: Go test suite passed; live login issued tokens, refresh succeeded, reuse of the old refresh token returned 401 `INVALID_REFRESH_TOKEN`; migration count is 3 and API readiness is 200.
- T2.2 marked complete.

## 2026-11-03 — T2.3 rooms and transactional membership

- Added room create, join, and leave endpoints protected by verified bearer access JWTs.
- Room creation atomically inserts the room and owner membership.
- Join locks the room row before counting active members, preventing capacity races; duplicate, full, closed, and kicked-member states map to explicit API errors.
- Leave is idempotency-safe at the database boundary and returns 404 when no active membership exists.
- Quality gate: `go vet ./...` and `go test ./...` passed in `golang:1.24-alpine`.
- Live verification: create succeeded, join succeeded, duplicate join returned 409, leave returned 204, invalid bearer returned 401.
- T2.3 marked complete. Concurrent race coverage remains scoped to T2.4.

## 2026-11-03 — T2.4 membership race/idempotency tests

- Added PostgreSQL integration tests for concurrent joins against a room capacity of 2 and concurrent leave requests for one membership.
- Tests assert exactly one successful capacity join, all other requests receive `ErrRoomFull`, and concurrent leave yields exactly one success plus one `ErrNotMember`.
- Default unit suite remains fast by skipping integration tests unless `CHATIFY_INTEGRATION=1`.
- Verification on `chatify-realtime-local-net`: both tests passed against the live PostgreSQL service.
- T2.4 marked complete.

## 2026-11-03 — T2.5 transactional outbox publisher

- Added `0004_outbox.sql` with pending/published state, attempts, error tracking, and lease fields.
- Room creation now inserts `room.created` into the outbox in the same PostgreSQL transaction as the room and owner membership.
- Added a dedicated Compose `outbox-publisher` worker using `FOR UPDATE SKIP LOCKED`, 30-second leases, Kafka/Redpanda acknowledgements, retry logging, and at-least-once delivery semantics.
- Fixed a deployment review issue where Docker `command` could not override the API image `ENTRYPOINT`; publisher now uses an explicit Compose `entrypoint`.
- Live verification: outbox pending count reached 0, `room-events` topic was auto-created with one partition, `published_at` and attempts were recorded, and Redpanda consumed the expected `room.created` JSON payload.
- T2.5 marked complete.

## 2026-11-03 — T3.1 Socket.IO gateway

- Added TypeScript Socket.IO gateway at `apps/signaling` with HTTP health endpoint, bounded room payload validation, room join/leave presence events, and offer/answer/ICE signal relay.
- Added reproducible npm lockfile and multi-stage Node 22 Alpine image; Compose exposes it only on `127.0.0.1:3001` for local development.
- Verification: `npm ci`, TypeScript build, Socket.IO presence/signal integration test, protocol tests, and `npm audit --audit-level=high` completed with zero vulnerabilities reported.
- T3.1 marked complete. JWT authentication and room authorization are intentionally next in T3.2.

## 2026-11-03 — T3.2 Socket.IO authentication and room authorization

- Added JWT HS256/issuer verification during Socket.IO handshake; invalid or missing credentials are rejected before connection.
- Gateway validates room access through the API internal membership endpoint over Docker DNS before joining a socket room.
- Added tests for authenticated presence/signal relay and bounded payloads; npm audit reports zero high vulnerabilities.
- Live Docker verification: active member received `{ok:true}` from `room:join`; non-member received `ROOM_ACCESS_DENIED`; API and signaling health endpoints were reachable.
- T3.2 marked complete. Reconnect/order/duplicate handling remains T3.3.

- Security review follow-up: signal relay now requires the socket to be an active member of the joined Socket.IO room; regression test covers pre-join injection and returns `ROOM_NOT_JOINED`.

## 2026-11-03 — T3.3 heartbeat, recovery, ordering, and deduplication

- Configured Socket.IO heartbeat (`pingInterval=10s`, `pingTimeout=5s`) and connection-state recovery for bounded reconnect windows.
- Added application heartbeat acknowledgement, per-room sequence numbers, required client `eventId`, duplicate suppression, and a 2048-event bounded cache.
- Verification: Socket.IO integration tests pass; live Docker client received first signal with `sequence=1` and duplicate acknowledgement without a second relay.
- T3.3 marked complete. Multi-instance sequence/dedupe state will require Redis adapter when scaling beyond one gateway.

## 2026-11-03 — T4.1 mediasoup worker

- Added `apps/media` using mediasoup `3.32.1` on Node 22, with bounded RTC UDP range configuration and worker-death fail-fast handling.
- Added Debian-based multi-stage image to use the official mediasoup prebuilt worker path; Compose exposes health on 3002 and UDP 40000-40020 locally.
- Verification: npm lock/install/build/test/audit passed; official mediasoup installation/API guidance was followed; Compose worker is healthy and `/health` returned 200 with a live worker PID.
- T4.1 marked complete. Producer/consumer transport flows remain T4.2.

## 2026-11-03 — T4.2 mediasoup publish/subscribe flow

- Refactored media worker into a managed runtime with room routers, WebRTC transports, producers, consumers, and lifecycle cleanup.
- Added internal HTTP control endpoints for router capabilities, transport creation, DTLS connect, audio/video produce, consume with `paused: true`, and consumer resume.
- Added validation and bounded JSON body handling; worker remains local/internal through Compose control port and dedicated UDP range.
- Verification: real mediasoup worker integration test created router → send transport → audio producer → receive transport → consumer → resume; live Compose HTTP smoke test completed the same flow successfully.
- T4.2 marked complete. Simulcast/adaptive bitrate and screen share remain T4.3.

## 2026-11-03 — T4.3 media controls and simulcast

- Added producer pause/resume/close controls, transport max-incoming-bitrate guard, and retained source metadata for microphone/camera/screen-share producers.
- Added real mediasoup integration coverage for video simulcast encodings and screen-share app data, plus producer lifecycle transitions.
- Verification: media worker build and real worker tests passed; npm dependency audit reports zero vulnerabilities; deployed worker is healthy.
- T4.3 marked complete. Group-call/livestream role orchestration remains T4.4.

## 2026-11-03 — T4.4 group-call and livestream roles

- Added persistent room modes: `group` and `livestream`, with a database check constraint and default `group` for existing rooms.
- Added API media-policy authorization derived from active membership: group members can publish/consume; livestream owners/moderators can publish and participants can consume only.
- Signaling now fetches media policy before joining, emits `room:policy`, and keeps room membership authorization in the same decision.
- Verification: migration versions 1–5 applied; Go `gofmt`, `go vet`, and `go test ./...` passed; signaling build/tests/audit passed with zero high vulnerabilities; live owner policy returned publish=true and participant policy returned publish=false/consume=true.
- T4.4 marked complete.

## 2026-11-03 — T5.1 idempotent text chat

- Added `chat_messages` migration with bounded client IDs/body, room-time index, and sender-scoped idempotency key.
- Added authenticated room-member message endpoint with validation and stable response on retries.
- Added transactional `chat.message.created` outbox event; retries do not create duplicate events.
- Verification: Go `gofmt`, `go vet`, and `go test ./...` passed; live duplicate submission returned the same message ID and one outbox event.
- T5.1 marked complete. Signed object upload URLs remain T5.2.

## 2026-11-03 — T5.2 signed RustFS upload policies

- Added MinIO Go SDK integration with RustFS-compatible presigned POST policies.
- Added authenticated room-member upload endpoint with server-generated room/user-scoped object keys, 10-minute expiry, exact content-type/size policy, and 25 MiB upper bound.
- API now ensures the configured RustFS bucket exists at startup; Compose provides internal and browser-facing storage endpoints.
- Verification: Go quality gates passed; Docker API rebuilt healthy; live curl multipart upload succeeded against `http://localhost:9000`.
- T5.2 marked complete. MIME/content validation and attachment authorization remain T5.3.

## 2026-11-03 — T5.3 attachment validation and authorization

- Added attachment intents with active-member/uploader authorization and pending/ready/rejected lifecycle.
- Restricted uploads to JPEG, PNG, GIF, WebP, PDF, and plain text, with a 25 MiB bound and exact-size signed policy.
- Added completion verification against RustFS object metadata; mismatched objects are rejected and removed.
- Verification: Go test/vet passed; live signed upload completed as `ready`; executable MIME request returned 422; schema reached version 7.
- T5.3 marked complete. Phase 6 verification and operational hardening remain.

## 2026-11-03 — T6.1 end-to-end smoke harness

- Added `harness/smoke.cjs` covering API health/auth/room/message idempotency, Socket.IO authentication/join/policy, and mediasoup router creation.
- Verification: harness passed from the Windows host and from an ephemeral Node container attached to `chatify-realtime-local-net`.
- T6.1 marked complete. Failure/load tests and operational runbook remain.

## 2026-11-03 — T6.2 failure and load harness

- Added `harness/failure-load.cjs` for concurrent message retry, room-capacity race, invalid Socket.IO credentials, invalid attachment MIME, and invalid media bitrate.
- Verification: live host run passed 20 concurrent duplicate submissions with one message ID, one successful capacity join plus three 409 responses, and all negative-path assertions.
- T6.2 marked complete. Operational runbook and launch checklist remain.

## 2026-11-03 — T6.3 operations and launch checklist

- Added `docs/OPERATIONS.md` covering startup, health, backups, migrations, object storage, realtime/media operations, incidents, and Docker disk recovery.
- Added `docs/LAUNCH_CHECKLIST.md` covering secret rotation, TLS/CORS, TURN/media networking, horizontal signaling prerequisites, attachment cleanup, backups, load tests, alerts, and rollback.
- T6.3 marked complete for the local project baseline. Production deployment still requires the explicit hardening items in the checklist.

## 2026-11-03 — Web room joining slice

- Added an accessible “join existing room” form to the React client and centralized Socket.IO room-session setup for newly created and joined rooms.
- Added responsive styling for the room-ID form and helper text; existing create-room and chat flows remain unchanged.
- Verification: Docker web image built successfully; web container returned HTTP 200; smoke and failure/load harnesses passed; two temporary local users created and joined the same room via the live API (`sameRoom=true`).

## 2026-11-03 — Web media controls slice

- Added microphone and screen-share controls using the existing authenticated mediasoup send transport; producer lifecycle cleanup covers toggle, browser share termination, sign-out, and unmount.
- Added accessible control labels/status text and responsive media-control layout.
- Verification: Docker TypeScript/Vite build passed; web container was recreated successfully; smoke and failure/load harnesses passed.

## 2026-11-03 — Media authorization hardening

- Media control requests now validate the JWT subject against the API's room media policy before router/transport/produce/consume operations.
- Runtime tracks transport, producer, and consumer owners; mutation endpoints reject resource access by a different user.
- Added `API_BASE_URL` to the media-worker Compose environment for the internal policy check.
- Verification: media Docker build passed with zero vulnerabilities; media tests passed 3/3; smoke and failure/load harnesses passed; the failure/load harness now asserts `unauthorizedMedia=true` and a valid JWT from a non-member receives HTTP 403 for router creation while a room member flow remains successful.

## 2026-11-03 — API security headers

- Added API response headers for MIME sniffing protection, clickjacking protection, referrer minimization, and a JSON-safe restrictive CSP.
- Added a safe local CORS fallback so zero-value test configuration never becomes wildcard CORS with credentials.
- Verification: Go `gofmt`, `go test ./...`, and `go vet ./...` passed; live API returned all expected headers; smoke and failure/load harnesses passed.

## 2026-11-03 — Media lifecycle cleanup

- Explicit producer close now removes ownership metadata; browser screen-share termination also requests server-side producer close before releasing the local track.
- Verification: media tests passed 3/3; web/media Docker builds passed; both live smoke and failure/load harnesses passed.

## 2026-11-03 — Frontend edge security headers

- Added Nginx headers for MIME sniffing, clickjacking, referrer, camera/microphone permissions, and a CSP allowing only the local API/signaling/media origins plus required Google font assets.
- Verification: Docker web build passed; live `http://localhost:3000` returned all expected headers; smoke and failure/load harnesses passed.

## 2026-11-03 — Web and signaling healthchecks

- Added a lightweight Nginx `/healthcheck` endpoint and Compose healthchecks for web and Socket.IO signaling.
- Verification: Compose config passed; both images built and deployed; after probe stabilization, web and signaling reported `healthy`; both endpoints returned HTTP 200; smoke and failure/load harnesses passed.

## 2026-11-03 — Room transition cleanup

- Centralized frontend room teardown: switching rooms now disconnects signaling, leaves the previous membership, closes all send/receive transports and producers/consumers, stops local tracks, and clears stale media state.
- Sign-out uses the same teardown path and disables the action while cleanup is in progress.
- Verification: Docker web build passed; deployed web service remained functional; smoke and failure/load harnesses passed.

## 2026-11-03 — Realtime chat event relay

- Added a KafkaJS consumer in signaling for the API outbox topic; bounded/validated `chat.message.created` payloads are broadcast to the matching Socket.IO room with event-id deduplication.
- Added readiness separation: `/health` is liveness, `/ready` waits for the Redpanda consumer group; Compose now gates signaling health on `/ready` and exits for restart if the relay cannot connect.
- Added a production Docker stage that prunes dev dependencies while retaining a full `build` stage for reproducible tests.
- Verification: signaling build passed; test stage passed 5/5; live `/health` and `/ready` returned expected states; smoke reported `realtimeChat=true`; failure/load harness passed including unauthorized media.

## 2026-11-03 — Chat history and pagination

- Added authenticated `GET /api/v1/rooms/:roomID/messages` with active-member authorization, bounded `limit` (1–100), and RFC3339 `before` cursor.
- Frontend now loads the latest 50 messages on room entry and de-duplicates history/realtime delivery by message ID.
- Verification: Go test/vet passed; API/web images deployed; smoke reported `realtimeChat=true,messageHistory=true`; failure/load harness passed.

## 2026-11-03 — Client reconnect room recovery

- Frontend now re-authorizes and rejoins the room on every Socket.IO reconnect; initial room setup waits for the join ACK before loading history.
- Reconnect failures surface an actionable error instead of silently showing a connected but unauthorized session.
- Verification: Docker web build passed; deployed client passed realtime chat/history smoke and failure/load harnesses.

## 2026-11-03 — Dependency and runtime quality gate

- Ran signaling dependency audit including dev dependencies after adding KafkaJS; no high-severity vulnerabilities were reported.
- All Compose services are running; core stateful services, API, media worker, web, and signaling report healthy where healthchecks are defined.
- Verification: smoke passed with realtime chat and message history; failure/load passed with duplicate, capacity, invalid-input, and unauthorized-media assertions.

## 2026-11-03 — Realtime text compression

- Enabled Socket.IO/Engine.IO HTTP compression and WebSocket per-message deflate for payloads at or above 1 KiB; small control frames avoid unnecessary compression overhead.
- WebRTC media remains codec/congestion-controlled by mediasoup (VP8/H264/Opus), independent of text compression.
- Verification: signaling test stage passed 5/5; production image built with zero vulnerabilities; live smoke and failure/load harnesses passed.

## 2026-11-03 — History query regression fix

- Failure/load verification caught that non-member history requests returned HTTP 200 instead of 403; after the authorization fix, the live member history path exposed a second SQL placeholder bug and returned HTTP 500.
- Corrected the message history query argument list and placeholder numbering so pagination works with and without a `before` cursor.
- Verification: API image rebuilt and redeployed; smoke passed with `realtimeChat=true,messageHistory=true`; failure/load passed with `invalidHistory=true,unauthorizedHistory=true,unauthorizedMedia=true`.

## 2026-11-03 — Existing producer discovery on room join

- Added an authenticated media endpoint to enumerate active producer IDs for a room, so a participant joining after media publication can discover existing camera/microphone/screen producers.
- Frontend now consumes discovered producers after history load and serializes receive-transport creation to avoid concurrent duplicate transports; live signal events continue to handle producers created later.
- Verification: media tests passed 3/3; media/web Docker builds passed; smoke passed with `producerDiscovery=true`; failure/load passed with `unauthorizedProducerDiscovery=true`.

## 2026-11-03 — Multi-track remote media tiles

- Replaced the single remote `<video>` sink with independent remote tiles per mediasoup producer, including hidden autoplay audio elements and responsive multi-video layout for group calls and screen-share tracks.
- Receive transport initialization is serialized so simultaneous producer discovery/signaling cannot create duplicate receive transports.
- Verification: web TypeScript/Vite build passed; web image redeployed; smoke and failure/load harnesses passed.

## 2026-11-03 — Browser E2E for chat and remote media

- Added a Playwright harness using two isolated Chromium contexts with fake camera/microphone permissions.
- The test covers UI login, owner room creation, guest room join, realtime chat delivery, owner camera publish, and guest remote video-tile rendering; expected anonymous refresh `422` responses are excluded from the network-error assertion.
- Verification: `PLAYWRIGHT_BROWSERS_PATH=D:\\chatify-realtime\\.cache\\ms-playwright npm run browser-e2e` passed with `{\"status\":\"ok\",\"browser\":true}`.

## 2026-11-03 — Browser harness dependency hardening

- Playwright was upgraded from 1.55.0 after `npm audit` reported a high-severity browser-download verification advisory.
- Verification: Playwright 1.64.1 installed, Chromium refreshed, `npm audit --omit=optional --audit-level=high` reported 0 vulnerabilities, and browser E2E passed again.

## 2026-11-03 — API rate-limit hardening

- Added configurable `/api` per-IP request limiting with a machine-readable `429 RATE_LIMITED` response and `Retry-After` header; local default is 300 requests per minute.
- Added a focused HTTP regression test and documented that production multi-instance deployments should use a shared Redis/edge limiter.
- Verification: API Docker build, Go test/vet, smoke, failure/load, and browser E2E all passed after deployment.

## 2026-11-03 — WebRTC transport lifecycle cleanup

- Added authenticated owner-only `POST /transports/:transportID/close`; frontend room teardown now closes owned send/receive transports, and failure/load releases its test transport.
- Added runtime coverage for transport removal and hardened smoke/failure harnesses to wait for service readiness, avoiding false failures during Kafka relay startup.
- Verification: media tests passed 3/3; signaling tests passed 6/6; API/web/media images deployed; smoke, failure/load, and browser E2E all passed repeatedly without UDP port exhaustion.

## 2026-11-03 — STUN/TURN client integration

- Added environment-driven STUN/TURN ICE server settings to media transport responses and passed them into both mediasoup send and receive transports.
- Local Compose defaults use the existing coturn service on `127.0.0.1`; production guidance requires a public TURN address and short-lived credentials.
- Verification: media tests passed 4/4; Compose config passed; smoke asserted `iceServers=true`; failure/load and browser E2E passed.

## 2026-11-03 — CI quality gates

- Added GitHub Actions jobs for Go, signaling, media, web, Compose validation, dependency audits, smoke/failure-load, and Playwright browser E2E.
- Added Dependabot updates for all npm manifests and the Go module; the workflow uses only local/test values from `.env.example` and never production credentials.
- Verification: workflow commands mirror the locally passing Docker/build/test commands; local service and browser evidence is recorded above.

## 2026-11-03 — Same-room directed signaling authorization

- Directed Socket.IO signals now verify that the target socket exists in the same room as the sender; unknown/cross-room targets receive `TARGET_NOT_IN_ROOM`.
- Verification: signaling tests passed 6/6; signaling image redeployed; smoke and failure/load harnesses passed.

## 2026-11-03 — Media bitrate and simulcast controls

- Camera now publishes low/medium/high simulcast layers capped at 180 kbps, 600 kbps, and 1.8 Mbps; screen share is capped at 2.5 Mbps; send transports request a 3 Mbps server cap.
- Recorded the bundle baseline and media policy in `docs/PERFORMANCE.md`.
- Verification: web build output was 480.20 kB raw / 118.37 kB gzip; smoke (`iceServers=true`), failure/load, and browser E2E all passed.

## 2026-11-03 — First-class 1-to-1 room mode

- Added a web “Gọi 1-1” creation option that sends a group room with `maxParticipants=2`; the room header identifies it as `1-1 CALL` while retaining the existing policy/migration contract.
- Browser E2E now selects the 1-1 option and verifies the resulting room before exercising chat and remote camera; smoke and failure/load remained green.

## 2026-11-03 — Browser livestream role verification

- Extended browser E2E to create a livestream, join a second viewer, assert the viewer is `Chỉ xem` with camera disabled, and verify the owner’s camera reaches the viewer.
- Verification: Playwright browser E2E passed after the livestream scenario; no page errors were observed.

## 2026-11-03 — Anonymous refresh response polish

- A refresh request without a `chatify_refresh` cookie now returns `204 No Content`; the frontend only applies a token when the response contains one.
- Verification: API and web images redeployed; all containers healthy; smoke passed with `realtimeChat=true,messageHistory=true,producerDiscovery=true,iceServers=true`; failure/load passed; browser E2E passed with `browser=true`.

## 2026-11-03 — Authorized attachment downloads

- Added `GET /api/v1/uploads/:attachmentID/download`, which returns a 10-minute signed GET URL only for active members of the attachment’s room and only after the object is marked `ready`.
- The object-storage bucket remains private; pending, rejected, cross-room, and non-member attachment IDs are not disclosed.
- Public-endpoint signing uses the public S3 host and a fixed S3 region so the API does not need to contact a browser-only `localhost` endpoint while generating the URL.
- Verification: Go test/vet passed in `golang:1.24-alpine`; API image rebuilt and redeployed; smoke passed with `attachmentDownload=true`; failure/load and Playwright browser E2E passed.

## 2026-11-03 — Abandoned attachment cleanup worker

- Added a restartable `attachment-cleanup` service that scans pending records older than the retention window, deletes the corresponding object, and marks the record rejected only after successful deletion; failures remain pending for retry.
- Local defaults are 24-hour retention and a 15-minute interval, configurable through Compose environment variables.
- Verification: Go test/vet passed; Compose config passed; API/cleanup images built; cleanup worker started; smoke and failure/load passed.

## 2026-11-03 — PostgreSQL backup/restore drill

- Added `scripts/backup-restore-drill.ps1` to create a custom-format dump, restore it into an isolated temporary database, verify `schema_migrations`, and clean up only the temporary database.
- Verification: drill passed locally; restored migration count was `7`; dump artifact was written under the ignored `backup/` directory.

## 2026-11-03 — API observability foundation

- Added safe `X-Request-ID` propagation and a Prometheus-compatible `/metrics` endpoint with bounded method/route/status labels, latency histograms, and readiness-failure count.
- Added unit coverage for metric rendering; smoke now verifies request-ID echo and metric output.
- Verification: Go test/vet, API redeploy, smoke, failure/load, and browser E2E passed.

## 2026-11-03 — Local Prometheus monitoring

- Added a Compose-managed Prometheus service, API scrape config, and alert rules for API unavailability, readiness failures, and sustained 5xx rate.
- A first scrape exposed a metrics-renderer nil-pointer panic; the renderer was changed to value-backed histograms and a concurrent regression test was added before redeploy.
- Verification: Prometheus target is `up`; all three rules loaded; smoke, failure/load, and browser E2E passed.

## 2026-11-03 — Media transport churn cleanup

- Added automatic cleanup for unconnected transports after the configurable idle timeout and for ICE-disconnected transports after a short grace period; lifecycle events now remove stale ownership state as well.
- This fixed reproducible browser E2E failures caused by the 21-port local UDP range being exhausted by abandoned sessions.
- Verification: media build and tests passed 5/5; browser E2E passed three consecutive runs; smoke/failure-load passed; Prometheus target remained `up`.

## 2026-11-03 — Signaling and media monitoring targets

- Added bounded `/metrics` endpoints to signaling and media, including relay readiness, socket count, worker availability, and transport/producer/consumer gauges.
- Prometheus now scrapes API, signaling, and media and loads target-down alerts for the two realtime services.
- Verification: signaling build-stage tests passed 6/6; media tests passed 5/5; both metrics endpoints returned 200; all three targets were `up`; smoke, failure/load, and browser E2E passed.

## 2026-11-03 — Monitoring CI gate

- Added `harness/monitoring.cjs` and a CI step that verifies API, signaling, and media Prometheus targets are `up` and required availability/5xx alert rules are loaded.
- Verification: local monitoring harness passed with three targets `up` and five rules loaded.

## 2026-11-03 — Redis Socket.IO adapter

- Added optional Redis pub/sub adapter configuration for signaling and enabled it in Compose with Redis health dependency; adapter clients are closed during graceful shutdown.
- Added Redis-backed atomic signal sequence/deduplication with a 5-minute event-key TTL; Redis state failures return `STATE_UNAVAILABLE` rather than silently producing inconsistent ordering.
- The adapter synchronizes Socket.IO broadcast/presence across instances, while signal ordering state is now shared as well.
- Verification: signaling build-stage tests passed 7/7; npm audit reported 0 vulnerabilities; final image logged `redis socket.io adapter connected`; smoke, failure/load, monitoring, and browser E2E passed.

## 2026-11-03 — Reconnect and media churn failure/load coverage

- Extended the failure/load harness to disconnect/reconnect/rejoin a Socket.IO client and create/close 30 WebRTC transports, exceeding the local 21-port UDP range.
- Verification: harness passed with `reconnectRejoin=true`, `mediaTransportChurn=30`, all existing idempotency/race/authorization assertions true.

## 2026-11-03 — API request body limit

- Added configurable `API_MAX_BODY_BYTES` (local default 1 MiB) to bound API request bodies; attachments continue through the signed object-storage upload flow.
- Verification: request-limit regression test, Go tests/vet, Compose config validation, API redeploy, and smoke passed.

## 2026-11-03 — Internal media-policy service authentication

- Added `INTERNAL_SERVICE_TOKEN` validation and constant-time checking for API internal room-policy endpoints; signaling and media include the token alongside the user JWT.
- Local signaling/media HTTP ports remain bound to loopback, and production still requires network policy/TLS outside Compose.
- Verification: API tests/vet, Compose validation, three-service rebuild/redeploy, smoke, failure/load, monitoring, and browser E2E passed.

## 2026-11-03 — Outbox observability

- Added an outbox health endpoint and Prometheus metrics for pending backlog, publish totals, cycle errors, and last successful cycle; added target-down and backlog alerts.
- The outbox Compose service now has a healthcheck. Monitoring verifies four targets and seven alert rules.
- Verification: Go tests/vet, Compose validation, correct outbox image rebuild, live metrics (`pending_events=0`, `errors=0`), and monitoring passed.

## 2026-11-03 — Backup drill shell-safety fix

- Hardened the backup/restore drill against PowerShell/`sh -c` quoting failures by passing PostgreSQL commands directly and validating the temporary database identifier.
- Verification: restore drill passed with migration count `7`; only `chatify_rollback_rehearsal` was created and cleaned up.

## 2026-11-03 — PostgreSQL pool observability

- API now exports bounded pool gauges/counters for max, total, acquired, idle, and waited acquisitions; Prometheus alerts on sustained pool exhaustion.
- Verification: Go tests/vet, API redeploy, live metrics (`max_conns=12`, `acquired_conns=0`, `idle_conns=1`), monitoring passed with four targets/eight alert rules, smoke/failure-load/browser E2E passed.

## 2026-11-03 — Object-storage observability

- API now exports object-storage operation/error counters without object-key labels; Prometheus alerts on new storage errors.
- Verification: Go tests/vet, API redeploy, smoke upload/download, live metrics (`operations=4`, `errors=0`), and monitoring passed with four targets/nine alert rules.

## 2026-11-03 — API response compression

- Added negotiated gzip/brotli compression for sufficiently large API responses; kept WebRTC media on codec/mediasoup compression and signaling per-message deflate.
- Verification: compression regression test, Go tests/vet, API redeploy, and smoke passed.

## 2026-11-03 — TURN UDP relay drill

- Added a repeatable local coturn drill using `turnutils_peer` and an authenticated `turnutils_uclient` against the container network IP; loopback peers remain blocked by default.
- Verification: `scripts/turn-udp-drill.ps1` passed with authenticated allocation and two-way UDP relay; production external-network verification is still required.

## 2026-11-03 — Redis-backed API rate limiting

- API now uses an atomic Redis Lua `INCR`/`PEXPIRE` counter with bounded IP-key cardinality in Compose; Redis failures return an explicit `503` instead of failing open. Unit-only apps with no Redis address retain the in-process fallback.
- Verification: Go tests/vet, API redeploy, smoke/failure-load passed; Redis showed shared `chatify:rate-limit:api:*` counters.

## 2026-11-03 — Signaling/media production configuration validation

- Signaling and media now fail fast in production when JWT/service token, explicit CORS, public announced address, or TURN credentials are missing; Compose passes `APP_ENV` and explicit local/production variables.
- Verification: signaling tests passed 8/8; media tests passed 7/7 with audit clean; Compose validation, service redeploy, smoke, browser E2E, and monitoring passed.

## 2026-11-03 — Coturn healthcheck

- Added a real UDP STUN healthcheck using `turnutils_stunclient`; media-worker now waits for coturn health in Compose.
- Verification: Compose validation, coturn health became healthy, media remained healthy, and smoke passed.

## 2026-11-03 — Consolidated local release gate

- Added `scripts/verify-local.ps1` to run the complete local validation sequence in one reproducible command; stack rebuild/start is opt-in with `-StartStack`.
- Verification: Compose/status, smoke, failure/load, TURN relay, monitoring (four targets/nine rules), and browser E2E all passed.

## 2026-11-03 — Production configuration fail-fast validation

- API now validates security-critical production settings at startup: JWT length, secure cookies, explicit CORS, HTTPS object-storage public URLs, and required database/object-storage credentials.
- Added `.env.production.example` with placeholders only; local Compose keeps `APP_ENV=local` and local HTTP object-storage defaults.
- Verification: Go tests and `go vet` passed; API redeployed healthy; smoke, failure/load, monitoring, and browser E2E passed.

## 2026-11-03 — Media ICE/DTLS failure alerting

- Media exports bounded `chatify_media_ice_failures_total` and `chatify_media_dtls_failures_total` counters; Prometheus raises `ChatifyMediaICEFailures` when either increases.
- Verification: media Docker build/test passed 7/7, media redeployed healthy, monitoring passed with four targets/ten alert rules, smoke/failure-load/TURN/browser E2E and the complete local release gate passed.

## 2026-11-03 — Browser media endpoint parameterization

- The web image now accepts `VITE_MEDIA_URL` alongside the API and signaling endpoints; Compose exposes these as `WEB_API_URL`, `WEB_SIGNALING_URL`, and `WEB_MEDIA_URL` so production builds do not silently target `localhost:3002`.
- Verification: Compose validation, web image build, smoke/failure-load, monitoring, TURN relay, and browser E2E passed through `scripts/verify-local.ps1`.

## 2026-11-03 — Runtime-configured web CSP

- Replaced the static nginx config with an official template and injected `WEB_CSP_CONNECT_SRC` at container startup; the policy remains explicit while supporting production API, signaling, and media origins.
- Verification: web image build, live CSP header inspection, smoke/failure-load, monitoring, TURN relay, and browser E2E passed through `scripts/verify-local.ps1`.

## 2026-11-03 — Browser access-token refresh

- The web client refreshes the rotating access token every 10 minutes against the refresh cookie and updates Socket.IO authentication for future reconnects; transient refresh failures are retried without tearing down the current session.
- Verification: web TypeScript/Vite build, smoke, failure/load, monitoring, TURN relay, and browser E2E passed through `scripts/verify-local.ps1`.

## 2026-11-03 — Production configuration preflight

- Added `scripts/verify-production-config.ps1`, a non-mutating preflight for production secrets, HTTPS origins, explicit CSP, public media address, TURN, and object-storage settings; it never prints secret values.
- Verification: `.env.production.example` was rejected with the expected placeholder errors, and local Compose config remained valid.

## 2026-11-03 — Production CSP transport hardening

- The production preflight now rejects plain HTTP/WS, wildcard, and local origins in `WEB_CSP_CONNECT_SRC`; only HTTPS/WSS endpoints are accepted for browser connections.
- Verification: production example continues to fail safely on placeholders, and local Compose validation remains green.

## 2026-11-03 — Production CSP endpoint consistency

- The production preflight now checks that CSP contains the exact configured API, signaling, media, and WSS signaling endpoints, preventing endpoint drift between the web build and nginx policy.
- Verification: `.env.production.example` was rejected safely on placeholders and local Compose validation passed.

## 2026-11-03 — Non-destructive backup restore drill

- The restore drill now refuses to overwrite an existing database and only drops the temporary database created by its current run; dump cleanup remains isolated to the container temp path.
- Verification: restore passed with migration count `7`; an existing-database test was rejected with exit `1`, then the exact test database was removed.

## 2026-11-03 — Auth response cache protection

- Token-issuing login/refresh responses now send `Cache-Control: no-store` and `Pragma: no-cache`; the smoke harness asserts the login header directly.
- Verification: API Docker build-stage tests/vet passed, API redeployed healthy, smoke, failure/load, monitoring, TURN relay, and browser E2E passed through the full local release gate.

## 2026-11-03 — Safe local backup retention

- Added a preview-first `scripts/prune-local-backups.ps1` tool that keeps the newest configurable number of dumps and requires explicit `-Apply` for deletion.
- Verification: preview identified six stale dumps (about 1.35 MB) while deleting none.

## 2026-11-03 — Room sharing affordance

- The active room header now offers an accessible `Sao chép ID` action with Clipboard API and textarea fallback plus transient success feedback.
- Verification: web Docker build, smoke, failure/load, monitoring, TURN relay, and browser E2E passed through the full local release gate.

## 2026-11-03 — Explicit leave-room action

- The active room header now exposes `Rời phòng`, reusing the existing membership, Socket.IO, WebRTC producer/transport, and local-track cleanup path.
- Verification: web Docker build, smoke, failure/load, monitoring, TURN relay, and browser E2E passed through the full local release gate.

## 2026-11-03 — Browser E2E diagnostics fix

- Corrected page-error collection to write to `diagnostics.consoleErrors`; uncaught browser exceptions are now reported accurately instead of causing a secondary undefined-variable error.
- Verification: Browser E2E passed with the corrected harness.

## 2026-11-03 — Room action regression coverage

- Browser E2E now verifies room-ID copy feedback and explicit leave-room behavior before continuing into the livestream scenario.
- Verification: Browser E2E passed with both multi-user call and livestream flows.

## 2026-11-03 — Operations handoff documentation

- README now links the production configuration preflight, non-destructive backup/restore drill, safe local backup retention preview, and production launch checklist.

## 2026-11-04 — Cross-browser room sharing and resume

- Reviewed the five quality axes around room join, copy, reload, chat, and media. Chrome and Edge with separate accounts worked when given a full room ID; the UI previously exposed only eight characters, and active members could not resume after reload because the API returned `ALREADY_MEMBER`.
- The room header now displays the complete selectable ID and reports clipboard failures. Joining an already active membership is idempotent, and an owner retains the owner role after leaving and rejoining.
- Added a Chrome/Edge regression test covering clipboard contents, reload and rejoin in both browsers, two-way chat, camera, and microphone. The local verification gate now runs it.
- Verification: Go integration tests, signaling tests (8), media tests (7), and the full local gate passed: smoke, capacity/load, TURN UDP, monitoring, Chromium E2E, Chrome/Edge E2E.

## 2026-11-04 — Logout and media cleanup review

- Found that UI-only logout left the refresh cookie active, so a reload restored the session. Added an API logout route that revokes the stored refresh token and clears the cookie; the web client calls it before leaving the room.
- The Chrome/Edge test now verifies that Edge remains signed out after a reload. A Go integration test confirms that the revoked refresh token cannot rotate.
- The expanded test exposed a cleanup race: producer and transport close requests could run concurrently and produce a 404. Media cleanup now closes producers before transports.
- Verification: Go integration tests and the full local release gate passed on the rebuilt stack, including Chrome/Edge camera, microphone, chat, reload/rejoin and logout.

## 2026-11-04 — In-room member list

- Added a room sidebar panel with connected member count, display names, roles, and online indicators. The signaling gateway publishes a room presence snapshot on join, leave, and disconnect; the browser loads names through a membership-protected API endpoint.
- Added Go integration coverage for roster access and leave behavior, signaling presence coverage, and Chrome/Edge checks for appearing and disappearing members.
- Visual QA: the two-member roster renders in the desktop room sidebar without obscuring video or chat.

## 2026-11-04 — Screen sharing media path and layout

- Reproduced a black remote video tile with a moving synthetic screen-share source: the sender's capture track was live, but ICE failed and RTP bytes sent remained zero. The media transport had only a UDP listen info; mediasoup ignores `enableTcp` when `listenInfos` is used.
- Added an explicit TCP listen info and exposed the matching Docker TCP RTP ports. The remote stage now stretches received video to the available width, and the local screen preview is not mirrored.
- The mediasoup 3.32.1 worker repeatedly exited with SIGSEGV after calls. Pinned 3.31.0 and made a worker death terminate the Node process so Docker restarts it. Three repeated Chrome/Edge sessions and the full local release gate passed with zero worker restarts.
- The Chrome/Edge test now checks actual decoded screen frames, video width relative to the stage, camera, mic, chat, rejoin, and logout. Media unit tests assert both UDP and TCP candidates.

## 2026-11-04 — Consistent left/right video orientation

- Checked an asymmetric red-left/blue-right moving screen source in Chrome and the decoded video in Edge. Raw pixels and computed CSS confirm screen sharing keeps left and right unchanged at both ends.
- Removed the camera self-preview's horizontal flip so the sender preview and viewer see the same orientation; remote video explicitly remains unflipped.
- Extended Chrome/Edge E2E to assert both color sides, no CSS transform on screen and camera video, and normal media delivery. Full local release gate passed.

## 2026-11-04 — Friends, locked rooms, profile and private messaging

- Added migration 0010, friendship requests, accepted-friend room suggestions, owner-controlled bcrypt room locks, and profile name/JPEG avatar updates.
- Added persisted friend messages with transactional outbox delivery to authenticated user socket rooms. Unread message and pending request counts appear in the top bar.
- Go integration test covers request permissions, room passwords and owner checks, suggestions, profile validation, message idempotency and stranger denial. Chrome/Edge E2E covers invitation acceptance, suggested locked rooms, password entry, realtime private messaging, display name and avatar.
- Verified `go test ./...`, focused PostgreSQL integration, existing Chrome/Edge call E2E, and new social E2E. Docker API, signaling and web rebuilt and healthy.

## 2026-11-04 — Compact account, audio and room-lock controls

- Replaced the large top-bar profile button and media-stage device selectors with a compact account dock at the bottom of the sidebar. The mic and speaker menus support keyboard Escape and outside-click dismissal.
- Moved owner room-lock settings into a popover; create/join password fields appear only when selected. When inside a room, creation and join forms fold behind a room-switch button so members remain visible.
- Verified Docker TypeScript/Vite build, Chrome/Edge social and media flows, and single-browser room/livestream flow. Visual checks at 1280px and 375px show member list and account dock without overlap or horizontal scrolling. Removed test accounts and rooms after verification.
