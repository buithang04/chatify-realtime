const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { io } = require("../apps/signaling/node_modules/socket.io-client");

const api = process.env.API_URL || "http://127.0.0.1:8080";
const signaling = process.env.SIGNALING_URL || "http://127.0.0.1:3001";
const media = process.env.MEDIA_URL || "http://127.0.0.1:3002";

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  if (!response.ok) throw new Error(`${options.method || "GET"} ${url} -> ${response.status}: ${text}`);
  return body;
}

async function waitFor(url, attempts = 30) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await request(url); }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 1000)); }
  }
  throw lastError;
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function main() {
  const live = await waitFor(`${api}/health/live`);
  const ready = await waitFor(`${api}/health/ready`);
  const signalHealth = await waitFor(`${signaling}/health`);
  const signalReady = await waitFor(`${signaling}/ready`);
  const mediaHealth = await waitFor(`${media}/health`);
  assert.equal(live.status, "ok");
  assert.equal(ready.status, "ready");
  assert.equal(signalHealth.status, "ok");
  assert.equal(signalReady.status, "ready");
  assert.equal(mediaHealth.status, "ok");
  const requestID = "smoke-request-id";
  const tracedHealth = await fetch(`${api}/health/live`, { headers: { "x-request-id": requestID } });
  assert.equal(tracedHealth.headers.get("x-request-id"), requestID);
  const metricsResponse = await fetch(`${api}/metrics`);
  assert.equal(metricsResponse.ok, true);
  const metricsText = await metricsResponse.text();
  assert.equal(metricsText.includes("chatify_http_requests_total"), true);

  const password = "StrongPass-123456";
  const email = `smoke-${crypto.randomUUID()}@example.test`;
  const registerResponse = await fetch(`${api}/api/v1/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, displayName: "Smoke" })
  });
  assert.equal(registerResponse.ok, true);
  const loginResponse = await fetch(`${api}/api/v1/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  assert.equal(loginResponse.ok, true);
  assert.equal(loginResponse.headers.get("cache-control"), "no-store");
  const login = await loginResponse.json();
  const headers = { authorization: `Bearer ${login.tokens.accessToken}`, "content-type": "application/json" };
  const room = await request(`${api}/api/v1/rooms`, {
    method: "POST", headers, body: JSON.stringify({ name: "Smoke room", maxParticipants: 4, mode: "group" })
  });
  const roomId = room.room.id;

  const first = await request(`${api}/api/v1/rooms/${roomId}/messages`, {
    method: "POST", headers, body: JSON.stringify({ clientMessageId: "smoke-1", body: "hello" })
  });
  const second = await request(`${api}/api/v1/rooms/${roomId}/messages`, {
    method: "POST", headers, body: JSON.stringify({ clientMessageId: "smoke-1", body: "hello" })
  });
  assert.equal(first.message.id, second.message.id);

  const socket = io(signaling, { transports: ["websocket"], auth: { token: login.tokens.accessToken }, timeout: 3000 });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  const policyPromise = new Promise((resolve) => socket.once("room:policy", resolve));
  const chatPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("chat event relay timeout")), 5000);
    socket.on("chat:message", (message) => {
      if (message.clientMessageId !== "smoke-realtime") return;
      clearTimeout(timer); socket.off("chat:message"); resolve(message);
    });
  });
  const join = await emitAck(socket, "room:join", { roomId });
  assert.equal(join.ok, true);
  const policy = await policyPromise;
  assert.equal(policy.roomId, roomId);
  assert.equal(policy.canPublish, true);
  const realtime = await request(`${api}/api/v1/rooms/${roomId}/messages`, {
    method: "POST", headers, body: JSON.stringify({ clientMessageId: "smoke-realtime", body: "realtime hello" })
  });
  const delivered = await chatPromise;
  assert.equal(delivered.id, realtime.message.id);
  assert.equal(delivered.body, "realtime hello");
  const history = await request(`${api}/api/v1/rooms/${roomId}/messages?limit=50`, { headers });
  assert.equal(history.messages.some((message) => message.id === realtime.message.id), true);
  socket.disconnect();

  const uploadIntent = await request(`${api}/api/v1/rooms/${roomId}/uploads`, {
    method: "POST", headers, body: JSON.stringify({ contentType: "text/plain", sizeBytes: 18 })
  });
  const form = new FormData();
  for (const [key, value] of Object.entries(uploadIntent.upload.fields)) form.append(key, value);
  form.append("file", new Blob(["chatify smoke file"], { type: "text/plain" }), "smoke.txt");
  const uploadResponse = await fetch(uploadIntent.upload.url, { method: "POST", body: form });
  assert.equal(uploadResponse.ok, true, `signed upload failed: ${uploadResponse.status}`);
  const completed = await request(`${api}/api/v1/uploads/${uploadIntent.attachment.id}/complete`, { method: "POST", headers, body: "{}" });
  assert.equal(completed.attachment.status, "ready");
  const download = await request(`${api}/api/v1/uploads/${uploadIntent.attachment.id}/download`, { headers });
  assert.equal(typeof download.download.url, "string");
  const downloaded = await fetch(download.download.url);
  const downloadedBody = await downloaded.text();
  assert.equal(downloaded.ok, true, `signed download failed: ${downloaded.status} ${downloadedBody.slice(0, 120)}`);
  assert.equal(downloadedBody, "chatify smoke file");

  const router = await request(`${media}/routers`, {
    method: "POST", headers, body: JSON.stringify({ roomId })
  });
  assert.equal(typeof router.routerId, "string");
  const transport = await request(`${media}/routers/${router.routerId}/transports`, {
    method: "POST", headers, body: "{}"
  });
  assert.equal(Array.isArray(transport.iceServers), true);
  assert.equal(transport.iceServers.some((server) => String(server.urls).startsWith("turn:")), true);
  await request(`${media}/transports/${transport.transportId}/close`, { method: "POST", headers, body: "{}" });
  const producers = await request(`${media}/rooms/${roomId}/producers`, {
    method: "POST", headers, body: "{}"
  });
  assert.deepEqual(producers.producerIds, []);

  console.log(JSON.stringify({ status: "ok", roomId, routerId: router.routerId, duplicateMessageId: first.message.id, realtimeChat: true, messageHistory: true, attachmentDownload: true, requestId: true, metrics: true, producerDiscovery: true, iceServers: true }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
