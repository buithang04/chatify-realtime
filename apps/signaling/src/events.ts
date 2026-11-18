import { Kafka, type Consumer, type EachMessagePayload } from "kafkajs";
import type { Server } from "socket.io";

const roomName = (roomId: string) => `room:${roomId}`;

export type ChatEventMessage = {
  id: string;
  roomId: string;
  senderId: string;
  clientMessageId: string;
  body: string;
  createdAt: string;
};

export type DirectEventMessage = ChatEventMessage & { recipientId: string };
export type FriendEventMessage = Omit<ChatEventMessage, "roomId"> & { recipientId: string };

export function parseFriendEvent(value: Buffer | null | undefined): FriendEventMessage | null {
  if (!value || value.length > 64 * 1024) return null;
  try {
    const candidate = JSON.parse(value.toString("utf8")) as Partial<FriendEventMessage>;
    if (!isBounded(candidate.id, 128) || !isBounded(candidate.senderId, 128) || !isBounded(candidate.recipientId, 128) || candidate.senderId === candidate.recipientId || !isBounded(candidate.clientMessageId, 128) || !isBounded(candidate.body, 4000) || !isBounded(candidate.createdAt, 64) || Number.isNaN(Date.parse(candidate.createdAt))) return null;
    return candidate as FriendEventMessage;
  } catch { return null; }
}

export function parseDirectEvent(value: Buffer | null | undefined): DirectEventMessage | null {
  const message = parseChatEvent(value);
  if (!message || !value) return null;
  try {
    const candidate = JSON.parse(value.toString("utf8")) as { recipientId?: unknown };
    return isBounded(candidate.recipientId, 128) && candidate.recipientId !== message.senderId
      ? { ...message, recipientId: candidate.recipientId }
      : null;
  } catch { return null; }
}

export function parseChatEvent(value: Buffer | null | undefined): ChatEventMessage | null {
  if (!value || value.length > 64 * 1024) return null;
  try {
    const candidate = JSON.parse(value.toString("utf8")) as Partial<ChatEventMessage>;
    if (!isBounded(candidate.id, 128) || !isBounded(candidate.roomId, 128) || !isBounded(candidate.senderId, 128) || !isBounded(candidate.clientMessageId, 128) || !isBounded(candidate.body, 4000) || !isBounded(candidate.createdAt, 64) || Number.isNaN(Date.parse(candidate.createdAt))) return null;
    return { id: candidate.id, roomId: candidate.roomId, senderId: candidate.senderId, clientMessageId: candidate.clientMessageId, body: candidate.body, createdAt: candidate.createdAt };
  } catch {
    return null;
  }
}

export async function startChatEventRelay(io: Server): Promise<() => Promise<void>> {
  const kafka = new Kafka({ clientId: "chatify-signaling", brokers: [process.env.REDPANDA_ADDRESS ?? "redpanda:9092"] });
  const consumer: Consumer = kafka.consumer({ groupId: process.env.SIGNALING_CONSUMER_GROUP ?? "chatify-signaling-chat-events" });
  const seen = new Set<string>();
  const relayStartedAt = Date.now();
  await consumer.connect();
  await consumer.subscribe({ topic: process.env.OUTBOX_TOPIC ?? "room-events", fromBeginning: false });
  await consumer.run({ eachMessage: async (payload) => relayMessage(io, seen, payload, relayStartedAt) });
  return async () => { await consumer.stop(); await consumer.disconnect(); };
}

async function relayMessage(io: Server, seen: Set<string>, payload: EachMessagePayload, relayStartedAt: number): Promise<void> {
  const eventType = headerValue(payload.message.headers?.["event-type"]);
  const eventId = headerValue(payload.message.headers?.["event-id"]);
  if ((eventType !== "chat.message.created" && eventType !== "chat.direct-message.created" && eventType !== "chat.friend-message.created") || !eventId || seen.has(eventId)) return;
  if (eventType === "chat.friend-message.created") {
    const friendMessage = parseFriendEvent(payload.message.value);
    if (!friendMessage || Date.parse(friendMessage.createdAt) < relayStartedAt) return;
    seen.add(eventId);
    if (seen.size > 4096) seen.delete(seen.values().next().value as string);
    io.to(`user:${friendMessage.senderId}`).to(`user:${friendMessage.recipientId}`).emit("chat:friend-message", friendMessage);
    return;
  }
  const message = eventType === "chat.direct-message.created" ? parseDirectEvent(payload.message.value) : parseChatEvent(payload.message.value);
  if (!message || Date.parse(message.createdAt) < relayStartedAt) return;
  seen.add(eventId);
  if (seen.size > 4096) seen.delete(seen.values().next().value as string);
  if (eventType === "chat.direct-message.created") {
    const direct = message as DirectEventMessage;
    const members = await io.in(roomName(direct.roomId)).fetchSockets();
    for (const member of members) {
      if (member.data.userId === direct.senderId || member.data.userId === direct.recipientId) {
        io.to(member.id).emit("chat:direct-message", direct);
      }
    }
  } else {
    io.to(roomName(message.roomId)).emit("chat:message", message);
  }
}

function headerValue(value: Buffer | string | Array<string | Buffer> | undefined): string | undefined {
  if (value === undefined || Array.isArray(value)) return undefined;
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

function isBounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
