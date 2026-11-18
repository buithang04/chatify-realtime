# Project Goals

## Primary goal

Build a Docker-first realtime communication platform with web and mobile clients, supporting video calls, group calls through an SFU, livestream rooms, screen sharing, realtime text chat, and file/image attachments.

## Current target

Create a production-shaped local environment first, then implement the system in verified increments. The first application increment is a Go API health service connected to PostgreSQL, Redis, and Redpanda.

## Success criteria

- Local infrastructure runs under the dedicated Compose project.
- Every application service has a health check.
- Authentication and room membership are authorization-safe.
- Race-sensitive operations are transactionally correct and idempotent.
- Web and Flutter clients can eventually join an SFU room and exchange media.
- Every completed task has test or runtime evidence.

## Non-goals for the first slice

- Recording or video transcoding.
- Public production deployment.
- Replacing the existing `C:\chatify-app` application.
- Building the entire product in one task.
