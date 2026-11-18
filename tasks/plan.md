# Implementation Plan: Chatify Realtime

## Overview

Implement a Docker-first realtime video communication system incrementally. The current repository contains only local infrastructure; the next vertical slice is a Go API that proves application-to-infrastructure connectivity.

## Architecture

- Go/Fiber API owns business state and authorization.
- PostgreSQL is source of truth; Redis is ephemeral; Redpanda is at-least-once event transport.
- Node.js/TypeScript is reserved for Socket.IO signaling and mediasoup.
- RustFS provides local S3-compatible storage.

## Definition of done for each task

- Acceptance criteria are satisfied.
- Focused tests or runtime checks pass.
- No secret is added to tracked files.
- The task is recorded in `harness/build-log.md`.
- The corresponding checkbox in `tasks/todo.md` is updated.

## Checkpoints

### Checkpoint 0 — Infrastructure

- [x] Compose config validates.
- [x] PostgreSQL, Redis, Redpanda, RustFS, and coturn run.
- [x] Health/status output has been observed.

### Checkpoint 1 — API foundation

- [x] Go API image builds.
- [x] `/health/live` returns 200.
- [x] `/health/ready` verifies PostgreSQL, Redis, and Redpanda.
- [x] API runs on the dedicated Docker network.

### Checkpoint 2 — Identity and rooms

- [x] Registration/login tests pass.
- [x] Room capacity race test passes.
- [x] Join/leave is idempotent.

All checkpoints above are covered by the current Docker release gate and the evidence recorded in `harness/build-log.md`; production-only deployment gates remain tracked in `docs/LAUNCH_CHECKLIST.md`.
