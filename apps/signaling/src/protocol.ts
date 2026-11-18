export type SignalKind = "offer" | "answer" | "ice" | "media-producer" | "media-producer-closed";

export interface RoomPayload {
  roomId: string;
}

export interface SignalPayload extends RoomPayload {
  kind: SignalKind;
  eventId: string;
  to?: string;
  data: unknown;
}

export interface Ack {
  ok: boolean;
  error?: string;
  duplicate?: boolean;
  sequence?: number;
}

const roomPattern = /^[0-9a-fA-F-]{8,64}$/;

export function validRoomId(value: unknown): value is string {
  return typeof value === "string" && roomPattern.test(value);
}

export function validateRoomPayload(value: unknown): value is RoomPayload {
  return typeof value === "object" && value !== null && validRoomId((value as RoomPayload).roomId);
}

export function validateSignalPayload(value: unknown): value is SignalPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as SignalPayload;
  if (!validateRoomPayload(payload) || !["offer", "answer", "ice", "media-producer", "media-producer-closed"].includes(payload.kind)) return false;
  if (typeof payload.eventId !== "string" || payload.eventId.length < 1 || payload.eventId.length > 128) return false;
  if (payload.to !== undefined && (typeof payload.to !== "string" || payload.to.length > 128)) return false;
  if (payload.data === undefined || JSON.stringify(payload.data).length > 64 * 1024) return false;
  if (payload.kind === "media-producer") {
    if (typeof payload.data !== "object" || payload.data === null || Array.isArray(payload.data)) return false;
    const media = payload.data as { producerId?: unknown; kind?: unknown };
    if (typeof media.producerId !== "string" || media.producerId.length < 1 || media.producerId.length > 128) return false;
    if (media.kind !== "audio" && media.kind !== "video") return false;
  }
  if (payload.kind === "media-producer-closed") {
    if (typeof payload.data !== "object" || payload.data === null || Array.isArray(payload.data)) return false;
    const media = payload.data as { producerId?: unknown };
    if (typeof media.producerId !== "string" || media.producerId.length < 1 || media.producerId.length > 128) return false;
  }
  return true;
}
