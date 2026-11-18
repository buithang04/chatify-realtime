import { FormEvent, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { UiIcon } from "./UiIcons";

type Props = { roomId: string; isLocked: boolean; isOwner: boolean; token: string; onChange: (isLocked: boolean) => void };

export function RoomLockControl({ roomId, isLocked, isOwner, token, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  }, [open]);

  async function updateLock(nextPassword: string) {
    setBusy(true); setError("");
    try {
      const result = await api<{ isLocked: boolean }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/password`, { method: "PUT", body: JSON.stringify({ password: nextPassword }) }, token);
      onChange(result.isLocked);
      setPassword("");
      setOpen(false);
      triggerRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không đổi được khóa phòng");
    } finally { setBusy(false); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length >= 6) void updateLock(password);
  }

  if (!isOwner) return isLocked ? <span className="room-lock-status"><UiIcon name="lock" size={16} /> Phòng có khóa</span> : null;

  return <div className="room-lock-control" ref={rootRef}>
    <button ref={triggerRef} type="button" className={`room-lock-trigger ${isLocked ? "is-locked" : ""}`} aria-label={isLocked ? "Cài đặt khóa phòng, đang khóa" : "Cài đặt khóa phòng, đang mở"} aria-expanded={open} aria-controls="room-lock-popover" onClick={() => { setOpen(!open); setError(""); }}><UiIcon name={isLocked ? "lock" : "unlock"} size={18} /><span>{isLocked ? "Đã khóa" : "Khóa phòng"}</span></button>
    {open && <section id="room-lock-popover" className="room-lock-popover" aria-label="Cài đặt khóa phòng">
      <div className="room-lock-popover-heading"><strong>{isLocked ? "Phòng đang có khóa" : "Phòng đang mở"}</strong><p>{isLocked ? "Người mới cần mật khẩu để tham gia." : "Đặt mật khẩu để giới hạn người tham gia."}</p></div>
      <form onSubmit={submit} className="room-lock-popover-form"><label htmlFor="room-new-password">{isLocked ? "Mật khẩu mới" : "Mật khẩu phòng"}</label><input ref={inputRef} id="room-new-password" type="password" autoComplete="new-password" minLength={6} maxLength={72} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Tối thiểu 6 ký tự" /><button className="primary" disabled={busy || password.length < 6}>{busy ? "Đang lưu…" : isLocked ? "Đổi mật khẩu" : "Đặt khóa"}</button></form>
      {isLocked && <button type="button" className="room-unlock-button" disabled={busy} onClick={() => void updateLock("")}><UiIcon name="unlock" size={16} /> Bỏ khóa phòng</button>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>}
  </div>;
}
