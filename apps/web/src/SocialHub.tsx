import { FormEvent, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { api, Friend, FriendMessage, UserProfile } from "./api";

type Props = { token: string; user: UserProfile | null; open: boolean; onClose: () => void; onProfileChange: (user: UserProfile) => void; onUnreadChange: (count: number) => void };

function Avatar({ name, data }: { name: string; data?: string }) {
  return data ? <img className="social-avatar" src={data} alt="" /> : <span className="social-avatar social-avatar-fallback" aria-hidden="true">{name.trim().slice(0, 1).toUpperCase() || "?"}</span>;
}

export function SocialHub({ token, user, open, onClose, onProfileChange, onUnreadChange }: Props) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState(user?.displayName ?? "");
  const [avatar, setAvatar] = useState(user?.avatarData ?? "");
  const [activeFriend, setActiveFriend] = useState<string | null>(null);
  const [messages, setMessages] = useState<FriendMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unread, setUnread] = useState<Record<string, number>>({});
  const activeFriendRef = useRef(activeFriend);
  activeFriendRef.current = activeFriend;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => { setName(user?.displayName ?? ""); setAvatar(user?.avatarData ?? ""); }, [user?.displayName, user?.avatarData]);
  useEffect(() => { onUnreadChange(Object.values(unread).reduce((sum, n) => sum + n, 0) + friends.filter((friend) => friend.status === "pending_incoming").length); }, [unread, friends, onUnreadChange]);

  async function refreshFriends() {
    const result = await api<{ friends: Friend[] }>("/api/v1/friends", {}, token);
    setFriends(result.friends);
  }
  useEffect(() => {
    void refreshFriends().catch(() => undefined);
    const timer = window.setInterval(() => void refreshFriends().catch(() => undefined), 10000);
    return () => window.clearInterval(timer);
  }, [token]);

  useEffect(() => {
    const socket = io(import.meta.env.VITE_SIGNALING_URL ?? "http://localhost:3001", { transports: ["websocket"], auth: { token } });
    socket.on("chat:friend-message", (message: FriendMessage) => {
      if (!user || (message.recipientId !== user.id && message.senderId !== user.id)) return;
      const peerID = message.senderId === user.id ? message.recipientId : message.senderId;
      if (activeFriendRef.current === peerID && openRef.current) {
        setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      } else if (message.senderId !== user.id) {
        setUnread((current) => ({ ...current, [peerID]: (current[peerID] ?? 0) + 1 }));
        setNotice("Có tin nhắn riêng mới");
      }
    });
    return () => { socket.disconnect(); };
  }, [token, user?.id]);

  async function run(action: () => Promise<unknown>, success: string) {
    setError(""); setNotice("");
    try { await action(); await refreshFriends(); setNotice(success); }
    catch (err) { setError(err instanceof Error ? err.message : "Thao tác thất bại"); }
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    await run(() => api("/api/v1/friends", { method: "POST", body: JSON.stringify({ email }) }, token), "Đã gửi lời mời kết bạn");
    setEmail("");
  }

  async function openChat(peerID: string) {
    setActiveFriend(peerID); setUnread((current) => ({ ...current, [peerID]: 0 })); setError("");
    try {
      const result = await api<{ messages: FriendMessage[] }>(`/api/v1/friends/${encodeURIComponent(peerID)}/messages`, {}, token);
      setMessages(result.messages);
    } catch (err) { setError(err instanceof Error ? err.message : "Không tải được tin nhắn"); }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!activeFriend || !draft.trim()) return;
    const body = draft.trim(); setDraft(""); setError("");
    try {
      const result = await api<{ message: FriendMessage }>(`/api/v1/friends/${encodeURIComponent(activeFriend)}/messages`, { method: "POST", body: JSON.stringify({ clientMessageId: crypto.randomUUID(), body }) }, token);
      setMessages((current) => current.some((item) => item.id === result.message.id) ? current : [...current, result.message]);
    } catch (err) { setDraft(body); setError(err instanceof Error ? err.message : "Không gửi được tin nhắn"); }
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault(); setError(""); setNotice("");
    try {
      const result = await api<{ user: UserProfile }>("/api/v1/profile", { method: "PATCH", body: JSON.stringify({ displayName: name, avatarData: avatar }) }, token);
      onProfileChange(result.user); setNotice("Đã lưu hồ sơ");
    } catch (err) { setError(err instanceof Error ? err.message : "Không lưu được hồ sơ"); }
  }

  async function chooseAvatar(file?: File) {
    if (!file) return;
    setError("");
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      const scale = Math.min(256 / bitmap.width, 256 / bitmap.height, 1);
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Không thể xử lý ảnh");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const data = canvas.toDataURL("image/jpeg", 0.82);
      if (data.length > 140000) throw new Error("Ảnh quá lớn. Hãy chọn ảnh khác.");
      setAvatar(data);
    } catch { setError("Không đọc được ảnh. Hãy chọn JPEG, PNG hoặc WebP."); }
  }

  const selected = friends.find((friend) => friend.userId === activeFriend);
  return <aside className={`social-hub ${open ? "is-open" : ""}`} aria-label="Bạn bè và hồ sơ" aria-hidden={!open} inert={!open}>
    <div className="social-head"><h2>Bạn bè & hồ sơ</h2><button type="button" className="quiet" onClick={onClose} aria-label="Đóng bạn bè">✕</button></div>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p className="social-notice" role="status">{notice}</p>}
    <form className="social-profile" onSubmit={saveProfile}><h3>Hồ sơ của tôi</h3><div className="social-profile-row"><Avatar name={name} data={avatar} /><label>Ảnh đại diện<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void chooseAvatar(event.target.files?.[0])} /></label></div><label>Tên hiển thị<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} required /></label><small>{user?.email}</small><div className="social-actions"><button type="button" className="secondary" onClick={() => setAvatar("")}>Xóa ảnh</button><button className="primary">Lưu hồ sơ</button></div></form>
    <form className="social-invite" onSubmit={(event) => void invite(event)}><h3>Thêm bạn</h3><label>Email của người bạn muốn kết bạn<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="ban@example.com" /></label><button className="secondary">Gửi lời mời</button></form>
    <section className="social-friends"><h3>Danh sách bạn bè</h3>{friends.length === 0 && <p className="muted">Chưa có bạn bè. Mời bằng email để bắt đầu.</p>}{friends.map((friend) => <div className="social-friend" key={friend.userId}><Avatar name={friend.displayName} data={friend.avatarData} /><div><strong>{friend.displayName}</strong><small>{friend.status === "accepted" ? friend.email : friend.status === "pending_incoming" ? "Đã gửi lời mời cho bạn" : "Đang chờ chấp nhận"}</small></div><div className="social-friend-actions">{friend.status === "pending_incoming" && <button type="button" onClick={() => void run(() => api(`/api/v1/friends/${friend.userId}/respond`, { method: "POST", body: JSON.stringify({ accept: true }) }, token), "Đã kết bạn")}>Chấp nhận</button>}{friend.status === "accepted" && <button type="button" onClick={() => void openChat(friend.userId)}>Nhắn tin{unread[friend.userId] ? ` (${unread[friend.userId]})` : ""}</button>}<button type="button" className="quiet" aria-label={`Hủy kết bạn hoặc lời mời với ${friend.displayName}`} onClick={() => void run(() => api(`/api/v1/friends/${friend.userId}`, { method: "DELETE" }, token), "Đã hủy kết bạn")}>✕</button></div></div>)}</section>
    {selected?.status === "accepted" && <section className="social-chat"><div className="social-chat-head"><h3>Nhắn riêng với {selected.displayName}</h3><button type="button" className="quiet" onClick={() => setActiveFriend(null)}>Đóng</button></div><div className="social-chat-messages" aria-live="polite">{messages.length === 0 && <p className="muted">Chưa có tin nhắn.</p>}{messages.map((message) => <article key={message.id} className={message.senderId === user?.id ? "mine" : "theirs"}><strong>{message.senderId === user?.id ? "Bạn" : selected.displayName}</strong><p>{message.body}</p></article>)}</div><form onSubmit={(event) => void send(event)} className="social-chat-form"><input aria-label={`Tin nhắn cho ${selected.displayName}`} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={4000} placeholder="Viết tin nhắn riêng…" /><button className="primary" disabled={!draft.trim()}>Gửi</button></form></section>}
  </aside>;
}
