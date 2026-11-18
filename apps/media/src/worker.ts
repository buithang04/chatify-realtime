import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import jwt from "jsonwebtoken";
import type { DtlsParameters, RtpCapabilities, RtpParameters, WebRtcTransport } from "mediasoup/types";
import { mediaConfig, type MediaConfig } from "./config.js";
import { MediaRuntime } from "./runtime.js";

const config = mediaConfig();
const runtime = await MediaRuntime.create(config);
const httpServer = createServer(async (request, response) => {
  try { await handle(request, response); }
  catch (error) {
    const message = error instanceof Error ? error.message : "INTERNAL_ERROR";
    const status = message === "UNAUTHENTICATED" ? 401 : message === "ROOM_ACCESS_DENIED" ? 403 : message.endsWith("_NOT_FOUND") ? 404 : message === "CANNOT_CONSUME" ? 409 : 400;
    writeJSON(response, status, { error: message });
  }
});
httpServer.listen(config.httpPort, "0.0.0.0", () => console.log(`media worker listening on ${config.httpPort}`));

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const allowedOrigin = process.env.MEDIA_CORS_ORIGIN ?? "http://localhost:3000";
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-headers", "content-type,authorization");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  if (request.method === "OPTIONS") return writeJSON(response, 204, {});
  if (request.method === "GET" && url.pathname === "/health") return writeJSON(response, 200, { status: "ok", workerPid: runtime.pid });
  if (request.method === "GET" && url.pathname === "/metrics") {
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    response.end([
      "# HELP chatify_media_worker_up Media worker process health.",
      "# TYPE chatify_media_worker_up gauge",
      "chatify_media_worker_up 1",
      "# HELP chatify_media_transports Current WebRTC transports.",
      "# TYPE chatify_media_transports gauge",
      `chatify_media_transports ${runtime.transportCount}`,
      "# HELP chatify_media_producers Current media producers.",
      "# TYPE chatify_media_producers gauge",
      `chatify_media_producers ${runtime.producerCount}`,
      "# HELP chatify_media_consumers Current media consumers.",
      "# TYPE chatify_media_consumers gauge",
      `chatify_media_consumers ${runtime.consumerCount}`,
      "# HELP chatify_media_ice_failures_total WebRTC ICE failures observed by the media worker.",
      "# TYPE chatify_media_ice_failures_total counter",
      `chatify_media_ice_failures_total ${runtime.iceFailures}`,
      "# HELP chatify_media_dtls_failures_total WebRTC DTLS failures observed by the media worker.",
      "# TYPE chatify_media_dtls_failures_total counter",
      `chatify_media_dtls_failures_total ${runtime.dtlsFailures}`,
      ""
    ].join("\n"));
    return;
  }
  const auth = request.method === "POST" ? authenticate(request) : undefined;
  if (request.method === "POST" && !auth) return writeJSON(response, 401, { error: "UNAUTHENTICATED" });
  if (request.method !== "POST") return writeJSON(response, 404, { error: "NOT_FOUND" });
  const body = await readJSON(request);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "routers") {
    const roomId = stringField(body, "roomId");
    await requirePolicy(auth!, roomId, "consume");
    const router = await runtime.createRouter(roomId);
    return writeJSON(response, 201, { routerId: router.id, rtpCapabilities: router.rtpCapabilities });
  }
  if (request.method === "POST" && parts.length === 3 && parts[0] === "rooms" && parts[2] === "producers") {
    const roomId = parts[1];
    await requirePolicy(auth!, roomId, "consume");
    return writeJSON(response, 200, { producerIds: runtime.listProducerIds(roomId) });
  }
  if (parts.length === 3 && parts[0] === "routers" && parts[2] === "transports") {
    await requirePolicy(auth!, runtime.routerRoomId(parts[1]), "consume");
    return writeJSON(response, 201, transportInfo(await runtime.createTransport(parts[1], auth!.userId), config.iceServers));
  }
  if (parts.length === 3 && parts[0] === "transports" && parts[2] === "close") {
    await requireOwner(auth!, runtime.transportRoomId(parts[1]), runtime.transportOwner(parts[1]));
    runtime.closeTransport(parts[1]);
    return writeJSON(response, 200, { ok: true });
  }
  if (parts.length === 3 && parts[0] === "transports" && parts[2] === "connect") {
    await requireOwner(auth!, runtime.transportRoomId(parts[1]), runtime.transportOwner(parts[1]));
    await runtime.connectTransport(parts[1], objectField(body, "dtlsParameters") as DtlsParameters);
    return writeJSON(response, 200, { ok: true });
  }
  if (parts.length === 3 && parts[0] === "transports" && parts[2] === "produce") {
    await requirePolicy(auth!, runtime.transportRoomId(parts[1]), "publish");
    await requireOwner(auth!, runtime.transportRoomId(parts[1]), runtime.transportOwner(parts[1]));
    const kind = stringField(body, "kind");
    if (kind !== "audio" && kind !== "video") throw new Error("INVALID_KIND");
    const producer = await runtime.produce(parts[1], kind, objectField(body, "rtpParameters") as RtpParameters, body.appData ?? {}, auth!.userId);
    return writeJSON(response, 201, { producerId: producer.id, kind: producer.kind });
  }
  if (parts.length === 3 && parts[0] === "transports" && parts[2] === "consume") {
    await requirePolicy(auth!, runtime.transportRoomId(parts[1]), "consume");
    await requireOwner(auth!, runtime.transportRoomId(parts[1]), runtime.transportOwner(parts[1]));
    const consumer = await runtime.consume(parts[1], stringField(body, "producerId"), objectField(body, "rtpCapabilities") as RtpCapabilities, auth!.userId);
    const source = consumer.appData.source === "screen" ? "screen" : consumer.appData.source === "camera" ? "camera" : undefined;
    return writeJSON(response, 201, { consumerId: consumer.id, producerId: consumer.producerId, kind: consumer.kind, source, rtpParameters: consumer.rtpParameters });
  }
  if (parts.length === 3 && parts[0] === "consumers" && parts[2] === "resume") {
    await requirePolicy(auth!, runtime.consumerRoomId(parts[1]), "consume");
    await requireOwner(auth!, runtime.consumerRoomId(parts[1]), runtime.consumerOwner(parts[1]));
    await runtime.getConsumer(parts[1]).resume();
    return writeJSON(response, 200, { ok: true });
  }
  if (parts.length === 3 && parts[0] === "producers" && (parts[2] === "pause" || parts[2] === "resume" || parts[2] === "close")) {
    await requirePolicy(auth!, runtime.producerRoomId(parts[1]), "publish");
    await requireOwner(auth!, runtime.producerRoomId(parts[1]), runtime.producerOwner(parts[1]));
    if (parts[2] === "pause") await runtime.pauseProducer(parts[1]);
    if (parts[2] === "resume") await runtime.resumeProducer(parts[1]);
    if (parts[2] === "close") runtime.closeProducer(parts[1]);
    return writeJSON(response, 200, { ok: true });
  }
  if (parts.length === 3 && parts[0] === "transports" && parts[2] === "max-incoming-bitrate") {
    await requirePolicy(auth!, runtime.transportRoomId(parts[1]), "publish");
    await requireOwner(auth!, runtime.transportRoomId(parts[1]), runtime.transportOwner(parts[1]));
    const bitrate = body.bitrate;
    if (typeof bitrate !== "number" || !Number.isInteger(bitrate) || bitrate < 10_000 || bitrate > 20_000_000) throw new Error("INVALID_BITRATE");
    await runtime.setMaxIncomingBitrate(parts[1], bitrate);
    return writeJSON(response, 200, { ok: true, bitrate });
  }
  return writeJSON(response, 404, { error: "NOT_FOUND" });
}

type AuthContext = { token: string; userId: string };
type MediaPolicy = { roomId: string; canPublish: boolean; canConsume: boolean };

function authenticate(request: IncomingMessage): AuthContext | null {
  const secret = process.env.JWT_SECRET ?? "";
  const header = request.headers.authorization ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1];
  if (secret.length < 32 || !token) return null;
  try {
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"], issuer: "chatify-api" });
    if (typeof payload === "string" || typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    return { token, userId: payload.sub };
  } catch {
    return null;
  }
}

async function requirePolicy(auth: AuthContext, roomId: string, capability: "publish" | "consume"): Promise<MediaPolicy> {
  const baseURL = process.env.API_BASE_URL ?? "http://api:8080";
  const response = await fetch(`${baseURL}/api/v1/internal/rooms/${encodeURIComponent(roomId)}/media-policy`, {
    headers: { Authorization: `Bearer ${auth.token}`, "X-Internal-Service-Token": process.env.INTERNAL_SERVICE_TOKEN ?? "" },
    signal: AbortSignal.timeout(2000),
  });
  if (response.status !== 200) throw new Error("ROOM_ACCESS_DENIED");
  const policy = await response.json() as Partial<MediaPolicy>;
  const allowed = capability === "publish" ? policy.canPublish : policy.canConsume;
  if (policy.roomId !== roomId || typeof policy.canPublish !== "boolean" || typeof policy.canConsume !== "boolean" || !allowed) throw new Error("ROOM_ACCESS_DENIED");
  return policy as MediaPolicy;
}

async function requireOwner(auth: AuthContext, roomId: string, ownerId: string): Promise<void> {
  if (!roomId || !ownerId || auth.userId !== ownerId) throw new Error("ROOM_ACCESS_DENIED");
}

function transportInfo(transport: WebRtcTransport, iceServers: MediaConfig["iceServers"]) {
  return { transportId: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters, sctpParameters: transport.sctpParameters, iceServers };
}

function stringField(body: Record<string, unknown>, key: string): string {
  if (typeof body[key] !== "string" || body[key].length === 0 || body[key].length > 512) throw new Error(`INVALID_${key.toUpperCase()}`);
  return body[key] as string;
}

function objectField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  if (typeof body[key] !== "object" || body[key] === null || Array.isArray(body[key])) throw new Error(`INVALID_${key.toUpperCase()}`);
  return body[key] as Record<string, unknown>;
}

function readJSON(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk: Buffer) => { data += chunk.toString(); if (data.length > 1_000_000) reject(new Error("PAYLOAD_TOO_LARGE")); });
    request.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("INVALID_JSON")); } });
    request.on("error", reject);
  });
}

function writeJSON(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const shutdown = () => { httpServer.close(); runtime.close(); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
