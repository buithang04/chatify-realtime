# Chatify Realtime Local

Docker-first local infrastructure for the realtime video call/livestream system.

This project is intentionally separate from `C:\chatify-app`.

## Prerequisites

- Docker Desktop for Windows with the WSL2 backend.
- Linux containers enabled.

## Start infrastructure

```powershell
Copy-Item .env.example .env.local
docker compose --project-name chatify-realtime-local --env-file .env.local -f infra/docker/compose.yaml up -d
docker compose --project-name chatify-realtime-local --env-file .env.local -f infra/docker/compose.yaml ps
```

## Stop infrastructure

```powershell
docker compose --project-name chatify-realtime-local --env-file .env.local -f infra/docker/compose.yaml stop
```

Do not use `down -v` unless you intentionally want to delete local database, broker, and object-storage data.

## Local services

| Service | Address | Purpose |
| --- | --- | --- |
| PostgreSQL | `localhost:5433` | Primary database |
| Redis | `localhost:6380` | Cache and ephemeral state |
| Redpanda Kafka API | `localhost:19092` | Event streaming |
| Redpanda Console | `http://localhost:8081` | Local broker inspection |
| RustFS S3 API | `http://localhost:9000` | S3-compatible object storage |
| RustFS Console | `http://localhost:9001` | Object-storage inspection |
| coturn STUN/TURN | `localhost:3478` | WebRTC NAT traversal |
| Signaling gateway | `http://localhost:3001` | Socket.IO room/presence/signal relay |
| Media worker | `http://localhost:3002` | mediasoup worker health/control plane |
| Outbox publisher | internal `outbox-publisher:8083` | event publishing health and backlog metrics |
| Prometheus | `http://localhost:9090` | API/signaling/media/outbox metrics and local alert rules |

The API also exposes `GET /metrics` for the Prometheus scrape. Keep that endpoint restricted to the monitoring network in production.

API responses negotiate gzip/brotli; WebRTC audio/video remains codec-compressed end-to-end and is never buffered or recompressed by the API.

Local TURN relay drill: `.\scripts\turn-udp-drill.ps1`.

Run the complete local release gate with `.\scripts\verify-local.ps1`; add `-StartStack` to build/start Compose or `-SkipBrowser` for a faster backend-only check.

Before production, run the non-mutating configuration preflight:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-production-config.ps1 -EnvFile .\.env.production
```

Operational helpers:

- `scripts/backup-restore-drill.ps1` verifies a PostgreSQL dump can be restored without overwriting an existing database.
- `scripts/prune-local-backups.ps1 -Keep 7` previews old local dumps; add `-Apply` only after reviewing the candidates.
- `docs/LAUNCH_CHECKLIST.md` records production-only gates that cannot be proven by the local Docker stack.

## Browser E2E

The Playwright harness verifies room creation/join, realtime chat, and remote camera rendering with fake media devices. The local release gate also runs a separate Chrome/Edge test for full room-ID copying, reload/rejoin, chat, camera, microphone, and a moving screen-share source. It checks that the receiving browser decodes frames and that shared video fills the media stage. Run the harness after the Compose stack is healthy:

```powershell
cd harness
npm install
$env:PLAYWRIGHT_BROWSERS_PATH = "D:\\chatify-realtime\\.cache\\ms-playwright"
npx playwright install chromium
npm run browser-e2e
npm run cross-browser-e2e
```

The browser binaries live under `.cache/` and are ignored by Git.

Inside a room, the sidebar shows connected members with their display names and roles. The list updates on join, leave, and disconnect; the member API only exposes a room roster to an active member.

The current room is restored after a page reload. Leaving a room clears it from the session; previously visited rooms appear on the home screen only while at least one member remains. A disconnected member is removed after a 12-second reconnect grace period.

Click another member's name to open private chat. `GET` and `POST /api/v1/rooms/:roomID/direct-messages/:peerID` require both users to be active room members. The server persists messages with a client message ID for retry safety and sends `chat:direct-message` only to the two users' sockets in that room. Room chat uses the separate `chat:message` event. The media toolbar can hide chat or enter browser fullscreen; a new message shows a short toast while chat is hidden. The member avatar highlights while voice activity is detected.
Incoming private messages show a short sender notification even while room chat is open, plus unread counts beside the sender and the chat icon. Opening that sender's private chat clears the count for that conversation.

## Friends, profiles, and locked rooms

Open **Bạn bè & hồ sơ** from the account bar in the sidebar to change your display name or avatar, add a friend by their account email, accept invitations, and send private messages. Friend messages are persisted separately from room chat and appear with an unread badge even when the panel is closed. The sidebar suggests active rooms containing your accepted friends. Locked rooms show a lock icon and require their password before a new member can join. A room owner can set, change, or remove the lock from the room header. Existing active members can restore their room after refreshing the page.

The compact account bar at the bottom of the sidebar opens **Bạn bè & hồ sơ** from the avatar or gear. Its microphone and speaker controls open device menus; microphone input changes are available while the mic is off. In a room, use **Tạo / tham gia phòng khác** to reveal the room forms. The room header lock button opens password settings for the owner.

The API stores only a bcrypt hash of the room password. Avatars are resized to at most 256 pixels in the browser and validated as JPEG on the API. The avatar data is limited to 100 KB. API integration coverage is in `apps/api/internal/auth/social_integration_test.go`; run `npm --prefix harness run social-e2e` for the Chrome/Edge user flow.
When a shared screen is present, the fullscreen button expands that screen to the entire viewport at its original aspect ratio. Chat is hidden on entry and can be opened as an overlay; exiting fullscreen restores the previous chat visibility. The media worker marks camera and screen producers separately so fullscreen keeps the screen selected when both are active.
Fullscreen screen viewing now fills the viewport by default, cropping edges when the capture and display aspect ratios differ. Viewers can switch to **Hiện toàn bộ** to see the uncropped source (with letterboxing) and back to **Lấp đầy**. Screen tracks prioritize detail and allow up to 8 Mb/s, with a 10 Mb/s sender transport ceiling; WebRTC still adapts to available bandwidth.

## Upload flow

1. An authenticated active room member requests `POST /api/v1/rooms/:roomID/uploads` with `contentType` and `sizeBytes`.
2. The API returns an attachment intent plus a short-lived RustFS signed POST policy.
3. The client submits the returned form fields and file directly to RustFS.
4. The client calls `POST /api/v1/uploads/:attachmentID/complete`; the API verifies the stored object's size and MIME type before marking it `ready`.
5. An active member requests `GET /api/v1/uploads/:attachmentID/download` to receive a 10-minute signed GET URL for a ready attachment.

Allowed attachment types are JPEG, PNG, GIF, WebP, PDF, and plain text. The maximum upload size is 25 MiB.

## Docker disk troubleshooting

Docker Desktop requires free space on the Windows system drive for its WSL2 data disk. If Docker reports that `docker_data.vhdx` is busy or cannot start, check:

```powershell
Get-PSDrive C
docker desktop logs --boot 0 --priority 2 --no-color
```

Keep at least a few GB free before restarting Docker Desktop. Do not delete the named Compose volumes unless local data can be discarded.
