import test from "node:test";
import assert from "node:assert/strict";
import { mediaConfig } from "./config.js";

test("media config has a bounded RTP port range", () => {
  assert.deepEqual(mediaConfig({ MEDIA_HTTP_PORT: "3002", RTC_MIN_PORT: "40000", RTC_MAX_PORT: "40020" }), {
    httpPort: 3002,
    rtcMinPort: 40000,
    rtcMaxPort: 40020,
    transportIdleTimeoutMs: 60000,
    announcedAddress: undefined,
    iceServers: []
  });
});

test("media config builds bounded STUN/TURN client settings", () => {
  assert.deepEqual(mediaConfig({
    RTC_STUN_URL: "stun:127.0.0.1:3478",
    RTC_TURN_URL: "turn:127.0.0.1:3478?transport=udp",
    RTC_TURN_USERNAME: "chatify",
    RTC_TURN_CREDENTIAL: "secret"
  }).iceServers, [
    { urls: "stun:127.0.0.1:3478" },
    { urls: "turn:127.0.0.1:3478?transport=udp", username: "chatify", credential: "secret" }
  ]);
});

test("media config rejects inverted RTP range", () => {
  assert.throws(() => mediaConfig({ RTC_MIN_PORT: "40020", RTC_MAX_PORT: "40000" }));
});

test("media config bounds idle transport cleanup timeout", () => {
  assert.equal(mediaConfig({ MEDIA_TRANSPORT_IDLE_TIMEOUT_MS: "30000" }).transportIdleTimeoutMs, 30000);
  assert.throws(() => mediaConfig({ MEDIA_TRANSPORT_IDLE_TIMEOUT_MS: "0" }));
});

test("production media config rejects local defaults", () => {
  assert.throws(() => mediaConfig({ APP_ENV: "production", JWT_SECRET: "01234567890123456789012345678901", INTERNAL_SERVICE_TOKEN: "01234567890123456789012345678901", MEDIA_CORS_ORIGIN: "https://app.example.com", RTC_ANNOUNCED_ADDRESS: "127.0.0.1", RTC_TURN_URL: "turn:turn.example.com:3478", RTC_TURN_USERNAME: "user", RTC_TURN_CREDENTIAL: "credential" }));
});

test("production media config accepts explicit public TURN settings", () => {
  assert.doesNotThrow(() => mediaConfig({ APP_ENV: "production", JWT_SECRET: "01234567890123456789012345678901", INTERNAL_SERVICE_TOKEN: "01234567890123456789012345678901", MEDIA_CORS_ORIGIN: "https://app.example.com", RTC_ANNOUNCED_ADDRESS: "media.example.com", RTC_TURN_URL: "turn:turn.example.com:3478", RTC_TURN_USERNAME: "user", RTC_TURN_CREDENTIAL: "credential" }));
});
