# Execution Plan

This is the ordered roadmap. `tasks/todo.md` is the executable checklist and `harness/build-log.md` is the evidence log.

## Phase 0: Local infrastructure — complete

- Docker Desktop/Linux engine.
- PostgreSQL, Redis, Redpanda, RustFS, coturn.
- Dedicated Compose project/network/volumes.
- Health checks and local ports.

## Phase 1: API foundation

1. Go API skeleton with live/ready health endpoints.
2. PostgreSQL migrations and connection pool.
3. Redis and Redpanda connectivity checks.
4. API Docker image and Compose integration.

## Phase 2: Identity and rooms

1. User registration/login/session primitives.
2. Room creation and membership.
3. Transactional capacity checks and idempotent join/leave.
4. Outbox event publisher.

## Phase 3: Realtime control plane

1. Socket.IO gateway.
2. Room authorization and presence heartbeat.
3. Reconnect and duplicate-event handling.

## Phase 4: Media plane

1. mediasoup worker/router.
2. Audio/video producer and consumer flows.
3. Simulcast, adaptive bitrate, mute/camera/screen share.
4. Group call and livestream roles.

## Phase 5: Chat and attachments

1. Idempotent text messages.
2. Signed RustFS uploads.
3. File/image validation and authorization.

## Phase 6: Verification

- Playwright web E2E.
- Flutter integration tests.
- Reconnect, concurrent join, load, and failure tests.
- Operational runbook and production-like Compose profile.

## Rules for plan execution

- Complete phases in order unless a task explicitly declares itself independent.
- Do not start the next phase while its checkpoint is failing.
- If a decision changes architecture, update this file and `tasks/todo.md` before coding.
