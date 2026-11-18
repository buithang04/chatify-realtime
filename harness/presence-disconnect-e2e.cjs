const assert = require("node:assert/strict");
const { io } = require("../apps/signaling/node_modules/socket.io-client");

const api = process.env.API_URL || "http://127.0.0.1:8080";
const signaling = process.env.SIGNALING_URL || "http://127.0.0.1:3001";

async function request(path, method, token, body) {
  const response = await fetch(api + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => undefined);
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}

async function account(label) {
  const email = `disconnect-${label}-${crypto.randomUUID()}@example.test`;
  const password = "StrongPass-123456";
  await request("/api/v1/auth/register", "POST", "", { email, password, displayName: label });
  const result = await request("/api/v1/auth/login", "POST", "", { email, password });
  return result.tokens.accessToken;
}

async function joinSocket(token, roomId) {
  const socket = io(signaling, { transports: ["websocket"], auth: { token } });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  const ack = await new Promise((resolve) => socket.emit("room:join", { roomId }, resolve));
  assert.equal(ack.ok, true, JSON.stringify(ack));
  return socket;
}

async function waitForMemberCount(roomId, token, count, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await request(`/api/v1/rooms/${roomId}/members`, "GET", token);
    if (result.members.length === count) return result.members;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`room ${roomId} did not reach ${count} active members`);
}

async function main() {
  const ownerToken = await account("owner");
  const guestToken = await account("guest");
  const created = await request("/api/v1/rooms", "POST", ownerToken, { name: "Disconnect drill", mode: "group", maxParticipants: 4 });
  const roomId = created.room.id;
  await request(`/api/v1/rooms/${roomId}/members`, "POST", guestToken);
  const owner = await joinSocket(ownerToken, roomId);
  let guest = await joinSocket(guestToken, roomId);
  try {
    guest.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    guest = await joinSocket(guestToken, roomId);
    await new Promise((resolve) => setTimeout(resolve, 11500));
    await waitForMemberCount(roomId, ownerToken, 2, 2000);
    guest.disconnect();
    await waitForMemberCount(roomId, ownerToken, 1, 16000);
    await request(`/api/v1/rooms/${roomId}/members/me`, "DELETE", ownerToken);
    const recent = await request("/api/v1/rooms/recent", "GET", guestToken);
    assert.equal(recent.rooms.some((room) => room.id === roomId), false);
    console.log(JSON.stringify({ status: "ok", refreshKeepsMembership: true, disconnectRemovesMembership: true, emptyRoomRemovedFromRecent: true }));
  } finally {
    owner.disconnect();
    guest.disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
