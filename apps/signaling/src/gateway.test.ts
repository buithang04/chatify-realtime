import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import jwt from "jsonwebtoken";
import { io as connect } from "socket.io-client";
import { createGateway, createRateLimiter, validateSignalingConfig } from "./server.js";

test("rate limiter bounds a socket signal window", () => {
  const allow = createRateLimiter(1, 60_000);
  assert.equal(allow(), true);
  assert.equal(allow(), false);
});

test("production signaling config rejects weak service security", () => {
  assert.throws(() => validateSignalingConfig({ APP_ENV: "production", JWT_SECRET: "short", INTERNAL_SERVICE_TOKEN: "short", CORS_ORIGIN: "https://app.example.com" }));
  assert.doesNotThrow(() => validateSignalingConfig({ APP_ENV: "production", JWT_SECRET: "01234567890123456789012345678901", INTERNAL_SERVICE_TOKEN: "01234567890123456789012345678901", CORS_ORIGIN: "https://app.example.com" }));
});

test("relays presence and signaling only after room join", async (t) => {
  const gateway = createGateway();
  const accessServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ roomId: "6607edb6-ca5f-4a37-85f6-08d49e171ce1", mode: "group", role: "participant", canPublish: true, canConsume: true, canModerate: false }));
  });
  await new Promise<void>((resolve) => accessServer.listen(0, resolve));
  const accessAddress = accessServer.address() as { port: number };
  const previousSecret = process.env.JWT_SECRET;
  const previousAPI = process.env.API_BASE_URL;
  process.env.JWT_SECRET = "01234567890123456789012345678901";
  process.env.API_BASE_URL = `http://127.0.0.1:${accessAddress.port}`;
  await new Promise<void>((resolve) => gateway.httpServer.listen(0, resolve));
  const address = gateway.httpServer.address();
  assert.equal(typeof address, "object");
  const url = `http://127.0.0.1:${(address as { port: number }).port}`;
  const metricsResponse = await fetch(`${url}/metrics`);
  assert.equal(metricsResponse.status, 200);
  assert.match(await metricsResponse.text(), /chatify_signaling_up 1/);
  const token = jwt.sign({ sub: "user-1" }, process.env.JWT_SECRET, { algorithm: "HS256", issuer: "chatify-api", expiresIn: "1h" });
  const first = connect(url, { transports: ["websocket"], auth: { token } });
  const second = connect(url, { transports: ["websocket"], auth: { token } });
  t.after(async () => {
    first.close();
    second.close();
    await new Promise<void>((resolve) => accessServer.close(() => resolve()));
    await new Promise<void>((resolve) => gateway.httpServer.close(() => resolve()));
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    if (previousAPI === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = previousAPI;
  });
  await Promise.all([
    new Promise<void>((resolve) => first.once("connect", () => resolve())),
    new Promise<void>((resolve) => second.once("connect", () => resolve()))
  ]);

  const roomId = "6607edb6-ca5f-4a37-85f6-08d49e171ce1";
  const notJoined = await new Promise<{ ok: boolean; error?: string }>((resolve) => second.emit("signal", { roomId, eventId: "not-joined", kind: "offer", data: {} }, resolve));
  assert.deepEqual(notJoined, { ok: false, error: "ROOM_NOT_JOINED" });
  const policyPromise = new Promise<{ mode: string; canPublish: boolean }>((resolve) => second.once("room:policy", resolve));
  await new Promise<void>((resolve, reject) => second.emit("room:join", { roomId }, (ack: { ok: boolean }) => ack.ok ? resolve() : reject(ack)));
  const policy = await policyPromise;
  assert.equal(policy.mode, "group");
  assert.equal(policy.canPublish, true);
  const presence = new Promise<{ roomId: string }>((resolve) => second.once("presence:joined", resolve));
  const membersSnapshot = new Promise<{ roomId: string; userIds: string[] }>((resolve) => second.once("presence:members", resolve));
  await new Promise<void>((resolve, reject) => first.emit("room:join", { roomId }, (ack: { ok: boolean }) => ack.ok ? resolve() : reject(ack)));
  assert.equal((await presence).roomId, roomId);
  assert.deepEqual(await membersSnapshot, { roomId, userIds: ["user-1"] });

  const deniedTarget = await new Promise<{ ok: boolean; error?: string }>((resolve) => first.emit("signal", { roomId, to: "socket-not-in-room", eventId: "target-check", kind: "offer", data: {} }, resolve));
  assert.deepEqual(deniedTarget, { ok: false, error: "TARGET_NOT_IN_ROOM" });

  const signal = new Promise<{ kind: string; from: string; sequence: number }>((resolve) => second.once("signal", resolve));
  const signalPayload = { roomId, eventId: "event-1", kind: "offer", data: { sdp: "test" } };
  let firstAck: { ok: boolean; sequence?: number } | undefined;
  await new Promise<void>((resolve, reject) => first.emit("signal", signalPayload, (ack: { ok: boolean; sequence?: number }) => { firstAck = ack; ack.ok ? resolve() : reject(ack); }));
  assert.equal((await signal).kind, "offer");
  assert.equal((await signal).sequence, firstAck?.sequence);
  await new Promise<void>((resolve, reject) => first.emit("signal", signalPayload, (ack: { ok: boolean; duplicate?: boolean }) => ack.ok ? resolve() : reject(ack)));
});
