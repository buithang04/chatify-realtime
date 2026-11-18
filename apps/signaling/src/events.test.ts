import test from "node:test";
import assert from "node:assert/strict";
import { parseChatEvent, parseFriendEvent } from "./events.js";

test("parses bounded chat outbox payloads", () => {
  const message = { id: "message-1", roomId: "room-1", senderId: "user-1", clientMessageId: "client-1", body: "hello", createdAt: new Date().toISOString() };
  assert.deepEqual(parseChatEvent(Buffer.from(JSON.stringify(message))), message);
});

test("rejects malformed or oversized chat outbox payloads", () => {
  assert.equal(parseChatEvent(Buffer.from("not-json")), null);
  assert.equal(parseChatEvent(Buffer.from(JSON.stringify({ id: "message-1", roomId: "room-1", senderId: "user-1", clientMessageId: "client-1", body: "x".repeat(4001), createdAt: new Date().toISOString() }))), null);
  assert.equal(parseChatEvent(Buffer.alloc(64 * 1024 + 1)), null);
});

test("friend message relay accepts only bounded recipient-specific payloads", () => {
  const message = { id: "message-1", senderId: "user-1", recipientId: "user-2", clientMessageId: "client-1", body: "hello", createdAt: new Date().toISOString() };
  assert.deepEqual(parseFriendEvent(Buffer.from(JSON.stringify(message))), message);
  assert.equal(parseFriendEvent(Buffer.from(JSON.stringify({ ...message, recipientId: "user-1" }))), null);
  assert.equal(parseFriendEvent(Buffer.from(JSON.stringify({ ...message, body: "x".repeat(4001) }))), null);
});
