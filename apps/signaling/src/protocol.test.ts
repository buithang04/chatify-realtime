import test from "node:test";
import assert from "node:assert/strict";
import { validateRoomPayload, validateSignalPayload } from "./protocol.js";

test("accepts a bounded room payload", () => {
  assert.equal(validateRoomPayload({ roomId: "6607edb6-ca5f-4a37-85f6-08d49e171ce1" }), true);
  assert.equal(validateRoomPayload({ roomId: "room with spaces" }), false);
});

test("rejects malformed or oversized signaling payloads", () => {
  assert.equal(validateSignalPayload({ roomId: "6607edb6-ca5f-4a37-85f6-08d49e171ce1", eventId: "event-1", kind: "offer", data: {} }), true);
  assert.equal(validateSignalPayload({ roomId: "6607edb6-ca5f-4a37-85f6-08d49e171ce1", eventId: "event-media", kind: "media-producer", data: { producerId: "producer-1", kind: "video" } }), true);
  assert.equal(validateSignalPayload({ roomId: "6607edb6-ca5f-4a37-85f6-08d49e171ce1", eventId: "event-closed", kind: "media-producer-closed", data: { producerId: "producer-1" } }), true);
  assert.equal(validateSignalPayload({ roomId: "6607edb6-ca5f-4a37-85f6-08d49e171ce1", eventId: "event-closed-bad", kind: "media-producer-closed", data: {} }), false);
  assert.equal(validateSignalPayload({ roomId: "6607edb6-ca5f-4a37-85f6-08d49e171ce1", eventId: "event-media-bad", kind: "media-producer", data: { producerId: "producer-1", kind: "unknown" } }), false);
  assert.equal(validateSignalPayload({ roomId: "6607edb6-ca5f-4a37-85f6-08d49e171ce1", eventId: "event-2", kind: "unknown", data: {} }), false);
  assert.equal(validateSignalPayload({ roomId: "6607edb6-ca5f-4a37-85f6-08d49e171ce1", eventId: "event-3", kind: "ice", data: "x".repeat(64 * 1024) }), false);
});
