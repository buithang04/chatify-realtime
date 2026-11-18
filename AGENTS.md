# Chatify Realtime: Codex Working Agreement

## Required context

Before changing code, read these files in order:

1. `GOALS.md`
2. `PLANS.md`
3. `tasks/todo.md`
4. The relevant source files and tests

## Execution loop

For every task, Codex must:

1. Select the first unchecked task whose dependencies are complete.
2. State the selected task and acceptance criteria.
3. Implement only that task.
4. Run the task's verification commands.
5. Record evidence in `harness/build-log.md`.
6. Mark the task complete only when the evidence passes.
7. Stop at the next checkpoint or when human approval is required.

Do not silently skip a task, weaken acceptance criteria, delete tests, or mark work complete without observed verification.

## Project boundaries

- Work only inside `D:\chatify-realtime`.
- Preserve `C:\chatify-app`; it is a separate legacy scaffold.
- Never commit `.env.local`, credentials, tokens, certificates, or private keys.
- Do not run destructive Docker commands such as `docker compose down -v` without explicit approval.
- Docker infrastructure must use the project name `chatify-realtime-local` and the dedicated network/volumes in `infra/docker/compose.yaml`.

## Architecture decisions

- Go + Fiber is the business API and source of truth.
- PostgreSQL is the authoritative database.
- Redis is ephemeral cache/presence/rate-limit state.
- Redpanda is the local Kafka-compatible event broker.
- Node.js/TypeScript owns Socket.IO signaling and mediasoup control.
- RustFS is the local S3-compatible object store.
- Web client is React + Vite; mobile client is Flutter.
- WebRTC media must never pass through PostgreSQL, Redis, Kafka, or the API.

## Quality bar

- Validate external input at service boundaries.
- Add focused tests for new behavior.
- Use idempotency for retried state-changing operations.
- Use PostgreSQL transactions/constraints for race-sensitive state.
- Run `git diff --check` and the task-specific tests before completion.
- Keep each increment small enough to review and recover.
