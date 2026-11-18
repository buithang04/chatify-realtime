const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";

export type Room = { id: string; name: string; ownerId: string; maxParticipants: number; mode: "group" | "livestream"; status: string; isLocked: boolean };
export type Message = { id: string; senderId: string; clientMessageId?: string; body: string; createdAt: string };
export type DirectMessage = Message & { roomId: string; recipientId: string };
export type MediaPolicy = { roomId: string; mode: string; role: string; canPublish: boolean; canConsume: boolean; canModerate: boolean };
export type RoomMember = { userId: string; displayName: string; role: "owner" | "moderator" | "participant"; avatarData: string };
export type RecentRoom = { id: string; name: string; mode: "group" | "livestream"; maxParticipants: number; activeMemberCount: number; isLocked: boolean; lastVisitedAt: string };
export type UserProfile = { id: string; email: string; displayName: string; avatarData: string };
export type Friend = { userId: string; email: string; displayName: string; avatarData: string; status: "accepted" | "pending_incoming" | "pending_outgoing"; createdAt: string };
export type FriendMessage = { id: string; senderId: string; recipientId: string; clientMessageId: string; body: string; createdAt: string };
export type SuggestedRoom = { id: string; name: string; mode: "group" | "livestream"; isLocked: boolean; activeMemberCount: number; friendNames: string[] };

export async function api<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers }
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  return body as T;
}

export function getApiUrl() { return API_URL; }
