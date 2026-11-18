# Performance notes

## Current local baseline

- Web production bundle: 480.39 kB raw / 118.43 kB gzip after simulcast, 1-to-1 UI controls, and refresh bootstrap polish.
- CSS: 6.86 kB raw / 2.31 kB gzip.
- Browser E2E remains green after media changes.

## Media policy

- Camera publishes three simulcast layers: 180 kbps, 600 kbps, and 1.8 Mbps.
- Screen share publishes one layer capped at 2.5 Mbps.
- The server caps incoming bitrate per send transport at 3 Mbps.
- Text uses Socket.IO compression only above the configured threshold; WebRTC media remains codec/congestion controlled.

These values are initial local defaults. Production tuning must be measured against network conditions and CPU/GPU profiles before changing them.
