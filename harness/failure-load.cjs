const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { io } = require("../apps/signaling/node_modules/socket.io-client");

const api = process.env.API_URL || "http://127.0.0.1:8080";
const signaling = process.env.SIGNALING_URL || "http://127.0.0.1:3001";
const media = process.env.MEDIA_URL || "http://127.0.0.1:3002";

async function raw(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: response.status, body };
}

async function waitFor(url, attempts = 30) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await raw(url);
      if (result.status >= 200 && result.status < 300) return result.body;
      lastError = new Error(`${url} -> ${result.status}`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw lastError;
}

async function ok(url, options = {}) {
  const result = await raw(url, options);
  if (result.status < 200 || result.status >= 300) throw new Error(`${url} -> ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function newUser() {
  const password = "StrongPass-123456";
  const email = `load-${crypto.randomUUID()}@example.test`;
  await ok(`${api}/api/v1/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, displayName: "Load" }) });
  const login = await ok(`${api}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  return { token: login.tokens.accessToken, headers: { authorization: `Bearer ${login.tokens.accessToken}`, "content-type": "application/json" } };
}

async function invalidSocket() {
  const socket = io(signaling, { transports: ["websocket"], auth: { token: "invalid-token" }, timeout: 3000, reconnection: false });
  await new Promise((resolve, reject) => {
    socket.once("connect_error", () => { socket.close(); resolve(); });
    socket.once("connect", () => { socket.close(); reject(new Error("invalid token connected")); });
    setTimeout(() => { socket.close(); reject(new Error("invalid token timeout")); }, 4000);
  });
}

async function reconnectAndRejoin(token, roomId) {
  const socket = io(signaling, { transports: ["websocket"], auth: { token }, timeout: 3000, reconnection: false });
  const connect = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket connect timeout")), 4000);
    socket.once("connect", () => { clearTimeout(timer); resolve(); });
    socket.once("connect_error", (error) => { clearTimeout(timer); reject(error); });
  });
  const join = () => new Promise((resolve, reject) => {
    socket.emit("room:join", { roomId }, (ack) => ack?.ok ? resolve() : reject(new Error(ack?.error || "rejoin denied")));
  });
  await connect();
  await join();
  socket.disconnect();
  socket.connect();
  await connect();
  await join();
  socket.close();
}

async function main() {
  await waitFor(`${api}/health/ready`);
  await waitFor(`${signaling}/ready`);
  await waitFor(`${media}/health`);
  const owner = await newUser();
  const room = await ok(`${api}/api/v1/rooms`, { method: "POST", headers: owner.headers, body: JSON.stringify({ name: "Failure load", maxParticipants: 2 }) });
  const roomId = room.room.id;

  const messages = await Promise.all(Array.from({ length: 20 }, () => ok(`${api}/api/v1/rooms/${roomId}/messages`, {
    method: "POST", headers: owner.headers, body: JSON.stringify({ clientMessageId: "concurrent-retry", body: "same message" })
  })));
  assert.equal(new Set(messages.map((item) => item.message.id)).size, 1);

  const users = await Promise.all(Array.from({ length: 4 }, newUser));
  const joins = await Promise.all(users.map((user) => raw(`${api}/api/v1/rooms/${roomId}/members`, { method: "POST", headers: user.headers })));
  assert.equal(joins.filter((item) => item.status === 200).length, 1);
  assert.equal(joins.filter((item) => item.status === 409).length, 3);

  const badMime = await raw(`${api}/api/v1/rooms/${roomId}/uploads`, { method: "POST", headers: owner.headers, body: JSON.stringify({ contentType: "application/x-msdownload", sizeBytes: 10 }) });
  assert.equal(badMime.status, 422);
  const invalidHistory = await raw(`${api}/api/v1/rooms/${roomId}/messages?limit=101`, { headers: owner.headers });
  assert.equal(invalidHistory.status, 422);
  await invalidSocket();

  const router = await ok(`${media}/routers`, { method: "POST", headers: owner.headers, body: JSON.stringify({ roomId }) });
  const transport = await ok(`${media}/routers/${router.routerId}/transports`, { method: "POST", headers: owner.headers, body: "{}" });
  const badBitrate = await raw(`${media}/transports/${transport.transportId}/max-incoming-bitrate`, { method: "POST", headers: owner.headers, body: JSON.stringify({ bitrate: 999 }) });
  assert.equal(badBitrate.status, 400);
  const closedTransport = await ok(`${media}/transports/${transport.transportId}/close`, { method: "POST", headers: owner.headers, body: "{}" });
  assert.equal(closedTransport.ok, true);
  await reconnectAndRejoin(owner.token, roomId);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const churnTransport = await ok(`${media}/routers/${router.routerId}/transports`, { method: "POST", headers: owner.headers, body: "{}" });
    await ok(`${media}/transports/${churnTransport.transportId}/close`, { method: "POST", headers: owner.headers, body: "{}" });
  }
  const outsider = await newUser();
  const deniedHistory = await raw(`${api}/api/v1/rooms/${roomId}/messages`, { headers: outsider.headers });
  assert.equal(deniedHistory.status, 403);
  const deniedMedia = await raw(`${media}/routers`, { method: "POST", headers: outsider.headers, body: JSON.stringify({ roomId }) });
  assert.equal(deniedMedia.status, 403);
  const deniedProducerDiscovery = await raw(`${media}/rooms/${roomId}/producers`, { method: "POST", headers: outsider.headers, body: "{}" });
  assert.equal(deniedProducerDiscovery.status, 403);

  console.log(JSON.stringify({ status: "ok", duplicateSubmissions: 20, successfulCapacityJoins: 1, rejectedCapacityJoins: 3, reconnectRejoin: true, mediaTransportChurn: 30, invalidSocket: true, invalidBitrate: true, invalidHistory: true, unauthorizedHistory: true, unauthorizedMedia: true, unauthorizedProducerDiscovery: true }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
