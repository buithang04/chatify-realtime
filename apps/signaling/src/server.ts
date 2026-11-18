import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { validateRoomPayload, validateSignalPayload, type Ack } from "./protocol.js";
import { startChatEventRelay } from "./events.js";
import { configureRedisAdapter } from "./redis-adapter.js";
import { connectRedisSignalState, LocalSignalState, type SignalState } from "./signal-state.js";

export interface MediaPolicy {
  roomId: string;
  mode: "group" | "livestream";
  role: "owner" | "moderator" | "participant";
  canPublish: boolean;
  canConsume: boolean;
  canModerate: boolean;
}

export function validateSignalingConfig(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.APP_ENV ?? "local").toLowerCase() !== "production") return;
  if ((env.JWT_SECRET ?? "").length < 32) throw new Error("JWT_SECRET must contain at least 32 characters in production");
  if ((env.INTERNAL_SERVICE_TOKEN ?? "").length < 32) throw new Error("INTERNAL_SERVICE_TOKEN must contain at least 32 characters in production");
  const cors = (env.CORS_ORIGIN ?? "").trim();
  if (!cors || cors === "*" || cors.includes("*")) throw new Error("CORS_ORIGIN must be explicit in production");
}

const roomName = (roomId: string) => `room:${roomId}`;

export interface Gateway {
  httpServer: HttpServer;
  io: Server;
  setChatRelayReady(ready: boolean): void;
}

export function createRateLimiter(max: number, windowMs = 60_000): () => boolean {
  const limit = Number.isInteger(max) && max > 0 ? max : 1;
  let windowStarted = Date.now();
  let count = 0;
  return () => {
    const now = Date.now();
    if (now - windowStarted >= windowMs) {
      windowStarted = now;
      count = 0;
    }
    if (count >= limit) return false;
    count += 1;
    return true;
  };
}

export function createGateway(signalState: SignalState = new LocalSignalState()): Gateway {
  let chatRelayReady = false;
  const disconnectTimers = new Map<string, NodeJS.Timeout>();
  const disconnectGraceMs = Number(process.env.PRESENCE_DISCONNECT_GRACE_MS ?? 12_000);
  const httpServer = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", chatEvents: chatRelayReady ? "ready" : "starting" }));
      return;
    }
    if (request.url === "/ready") {
      response.writeHead(chatRelayReady ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: chatRelayReady ? "ready" : "starting", chatEvents: chatRelayReady ? "ready" : "starting" }));
      return;
    }
    if (request.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      response.end([
        "# HELP chatify_signaling_up Signaling gateway process health.",
        "# TYPE chatify_signaling_up gauge",
        "chatify_signaling_up 1",
        "# HELP chatify_signaling_chat_relay_ready Whether the Redpanda chat relay is ready.",
        "# TYPE chatify_signaling_chat_relay_ready gauge",
        `chatify_signaling_chat_relay_ready ${chatRelayReady ? 1 : 0}`,
        "# HELP chatify_signaling_connected_sockets Current authenticated Socket.IO sockets.",
        "# TYPE chatify_signaling_connected_sockets gauge",
        `chatify_signaling_connected_sockets ${io?.of("/").sockets.size ?? 0}`,
        ""
      ].join("\n"));
      return;
    }
    response.writeHead(404).end();
  });
  const io = new Server(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN?.split(",").filter(Boolean) ?? ["http://localhost:3000"] },
    maxHttpBufferSize: 64 * 1024,
    httpCompression: { threshold: 1024 },
    perMessageDeflate: { threshold: 1024 },
    pingInterval: 10_000,
    pingTimeout: 5_000,
    connectionStateRecovery: { maxDisconnectionDuration: 120_000, skipMiddlewares: false }
  });
  const configuredSignalLimit = Number.parseInt(process.env.SIGNAL_RATE_LIMIT_MAX ?? "240", 10);
  const signalRateLimit = Number.isInteger(configuredSignalLimit) && configuredSignalLimit > 0 ? configuredSignalLimit : 240;

  io.use((socket, next) => {
    const configuredSecret = process.env.JWT_SECRET ?? "";
    const supplied = typeof socket.handshake.auth?.token === "string"
      ? socket.handshake.auth.token
      : socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!supplied || configuredSecret.length < 32) return next(new Error("UNAUTHENTICATED"));
    try {
      const payload = jwt.verify(supplied, configuredSecret, { algorithms: ["HS256"], issuer: "chatify-api" });
      if (typeof payload === "string" || !payload.sub) return next(new Error("UNAUTHENTICATED"));
      socket.data.userId = payload.sub;
      socket.data.accessToken = supplied;
      next();
    } catch {
      next(new Error("UNAUTHENTICATED"));
    }
  });

  async function publishPresence(roomId: string): Promise<void> {
    const room = roomName(roomId);
    const sockets = await io.in(room).fetchSockets();
    const userIds = [...new Set(sockets.map((member) => member.data.userId).filter((id): id is string => typeof id === "string"))];
    io.to(room).emit("presence:members", { roomId, userIds });
  }

  function cancelDisconnectedLeave(roomId: string, userId: string): void {
    const key = `${roomId}:${userId}`;
    const timer = disconnectTimers.get(key);
    if (timer) clearTimeout(timer);
    disconnectTimers.delete(key);
  }

  function scheduleDisconnectedLeave(roomId: string, userId: string): void {
    const key = `${roomId}:${userId}`;
    cancelDisconnectedLeave(roomId, userId);
    const timer = setTimeout(() => {
      disconnectTimers.delete(key);
      void (async () => {
        const sockets = await io.in(roomName(roomId)).fetchSockets();
        if (sockets.some((member) => member.data.userId === userId)) return;
        const baseURL = process.env.API_BASE_URL ?? "http://api:8080";
        const response = await fetch(`${baseURL}/api/v1/internal/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(userId)}/disconnect`, {
          method: "POST",
          headers: { "X-Internal-Service-Token": process.env.INTERNAL_SERVICE_TOKEN ?? "" },
          signal: AbortSignal.timeout(3000)
        });
        if (!response.ok) throw new Error(`disconnect cleanup failed (${response.status})`);
        await publishPresence(roomId);
      })().catch((error) => {
        console.error("room disconnect cleanup failed", { roomId, error });
        scheduleDisconnectedLeave(roomId, userId);
      });
    }, Number.isFinite(disconnectGraceMs) && disconnectGraceMs >= 1000 ? disconnectGraceMs : 12_000);
    timer.unref();
    disconnectTimers.set(key, timer);
  }

  io.on("connection", (socket) => {
	void socket.join(`user:${socket.data.userId}`);
    const allowSignal = createRateLimiter(signalRateLimit);
    const allowVoice = createRateLimiter(240);
    const joinedRoomIds = new Set<string>();
    const publishedProducerIds = new Map<string, Set<string>>();
    socket.on("disconnecting", () => {
      for (const name of socket.rooms) if (name.startsWith("room:")) joinedRoomIds.add(name.slice(5));
    });
    socket.on("disconnect", () => {
      for (const roomId of joinedRoomIds) {
        for (const producerId of publishedProducerIds.get(roomId) ?? []) {
          io.to(roomName(roomId)).emit("signal", { roomId, eventId: randomUUID(), kind: "media-producer-closed", data: { producerId } });
        }
        void publishPresence(roomId).catch(() => undefined);
        scheduleDisconnectedLeave(roomId, socket.data.userId);
      }
    });
    socket.on("room:join", (payload: unknown, acknowledge?: (ack: Ack) => void) => {
      if (!validateRoomPayload(payload)) return acknowledge?.({ ok: false, error: "INVALID_ROOM" });
      void authorizeRoom(socket.data.accessToken, payload.roomId).then((policy) => {
        if (!policy) return acknowledge?.({ ok: false, error: "ROOM_ACCESS_DENIED" });
        const room = roomName(payload.roomId);
        void Promise.resolve(socket.join(room)).then(() => {
          cancelDisconnectedLeave(payload.roomId, socket.data.userId);
          socket.emit("room:policy", policy);
          socket.to(room).emit("presence:joined", { socketId: socket.id, roomId: payload.roomId });
          acknowledge?.({ ok: true });
          void publishPresence(payload.roomId).catch(() => undefined);
        }).catch(() => acknowledge?.({ ok: false, error: "ROOM_JOIN_UNAVAILABLE" }));
      }).catch(() => acknowledge?.({ ok: false, error: "ROOM_ACCESS_UNAVAILABLE" }));
    });

    socket.on("room:leave", (payload: unknown, acknowledge?: (ack: Ack) => void) => {
      if (!validateRoomPayload(payload)) return acknowledge?.({ ok: false, error: "INVALID_ROOM" });
      const room = roomName(payload.roomId);
      void Promise.resolve(socket.leave(room)).then(() => {
        socket.to(room).emit("presence:left", { socketId: socket.id, roomId: payload.roomId });
        acknowledge?.({ ok: true });
        void publishPresence(payload.roomId).catch(() => undefined);
      }).catch(() => acknowledge?.({ ok: false, error: "ROOM_LEAVE_UNAVAILABLE" }));
    });

    socket.on("presence:heartbeat", (acknowledge?: (ack: Ack & { serverTime?: number }) => void) => {
      acknowledge?.({ ok: true, serverTime: Date.now() });
    });

    socket.on("voice:activity", (payload: unknown) => {
      if (!allowVoice() || typeof payload !== "object" || payload === null) return;
      const voice = payload as { roomId?: unknown; speaking?: unknown };
      const speaking = voice.speaking;
      if (!validateRoomPayload(voice) || typeof speaking !== "boolean" || !socket.rooms.has(roomName(voice.roomId))) return;
      io.to(roomName(voice.roomId)).emit("voice:activity", { roomId: voice.roomId, userId: socket.data.userId, speaking });
    });

    socket.on("signal", (payload: unknown, acknowledge?: (ack: Ack) => void) => {
      if (!allowSignal()) return acknowledge?.({ ok: false, error: "RATE_LIMITED" });
      if (!validateSignalPayload(payload)) return acknowledge?.({ ok: false, error: "INVALID_SIGNAL" });
      const room = roomName(payload.roomId);
      if (!socket.rooms.has(room)) return acknowledge?.({ ok: false, error: "ROOM_NOT_JOINED" });
      if (payload.to) {
        const target = io.sockets.sockets.get(payload.to);
        if (!target || !target.rooms.has(room)) return acknowledge?.({ ok: false, error: "TARGET_NOT_IN_ROOM" });
      }
      void signalState.claim(payload.roomId, payload.eventId).then(({ duplicate, sequence }) => {
        if (duplicate) return acknowledge?.({ ok: true, duplicate: true, sequence });
        if (payload.kind === "media-producer") {
          const producerId = (payload.data as { producerId: string }).producerId;
          const ids = publishedProducerIds.get(payload.roomId) ?? new Set<string>();
          ids.add(producerId);
          publishedProducerIds.set(payload.roomId, ids);
        }
        if (payload.kind === "media-producer-closed") publishedProducerIds.get(payload.roomId)?.delete((payload.data as { producerId: string }).producerId);
        const target = payload.to ? socket.to(payload.to) : socket.to(room);
        target.emit("signal", { ...payload, from: socket.id, sequence });
        acknowledge?.({ ok: true, sequence });
      }).catch(() => acknowledge?.({ ok: false, error: "STATE_UNAVAILABLE" }));
    });
  });
  return { httpServer, io, setChatRelayReady: (ready) => { chatRelayReady = ready; } };
}

async function authorizeRoom(token: string, roomId: string): Promise<MediaPolicy | null> {
  const baseURL = process.env.API_BASE_URL ?? "http://api:8080";
  const response = await fetch(`${baseURL}/api/v1/internal/rooms/${encodeURIComponent(roomId)}/media-policy`, {
    headers: { Authorization: `Bearer ${token}`, "X-Internal-Service-Token": process.env.INTERNAL_SERVICE_TOKEN ?? "" },
    signal: AbortSignal.timeout(2000)
  });
  if (response.status !== 200) return null;
  const policy = await response.json() as Partial<MediaPolicy>;
  if (policy.roomId !== roomId || !policy.mode || !policy.role || typeof policy.canPublish !== "boolean" || typeof policy.canConsume !== "boolean") return null;
  return policy as MediaPolicy;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    validateSignalingConfig();
    const signalState = await connectRedisSignalState();
    const gateway = createGateway(signalState);
    const { httpServer, io } = gateway;
    const port = Number(process.env.SIGNALING_PORT ?? 3001);
    const closeRedisAdapter = await configureRedisAdapter(io);
    httpServer.listen(port, "0.0.0.0", () => console.log(`signaling listening on ${port}`));
    let stopRelay: (() => Promise<void>) | undefined;
    try {
      stopRelay = await startChatEventRelay(io);
      gateway.setChatRelayReady(true);
      console.log("chat event relay connected");
    } catch (error) {
      console.error("chat event relay unavailable", error);
      process.exit(1);
    }
    const shutdown = async () => { await stopRelay?.(); await closeRedisAdapter(); await signalState?.close(); await new Promise<void>((resolve) => httpServer.close(() => resolve())); };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  })().catch((error) => { console.error("signaling startup failed", error); process.exit(1); });
}
