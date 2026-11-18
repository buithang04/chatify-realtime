import { useEffect, useRef, useState } from "react";
import type { UserProfile } from "./api";
import { UiIcon } from "./UiIcons";

type AudioMenu = "input" | "output" | null;
type Props = {
  user: UserProfile | null;
  unread: number;
  connected: boolean;
  canPublish: boolean;
  microphoneOn: boolean;
  onToggleMicrophone: () => void;
  speakerMuted: boolean;
  onToggleSpeaker: () => void;
  onOpenSocial: () => void;
  audioInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
  selectedAudioInputId: string;
  selectedAudioOutputId: string;
  onSelectAudioInput: (id: string) => void;
  onSelectAudioOutput: (id: string) => void;
  micLevel: number;
};

export function AccountDock(props: Props) {
  const [menu, setMenu] = useState<AudioMenu>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const inputButtonRef = useRef<HTMLButtonElement>(null);
  const outputButtonRef = useRef<HTMLButtonElement>(null);
  const firstOptionRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menu) return;
    firstOptionRef.current?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!dockRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenu(null);
      (menu === "input" ? inputButtonRef : outputButtonRef).current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  }, [menu]);

  const devices = menu === "input" ? props.audioInputs : props.audioOutputs;
  const selected = menu === "input" ? props.selectedAudioInputId : props.selectedAudioOutputId;
  const choose = menu === "input" ? props.onSelectAudioInput : props.onSelectAudioOutput;
  const defaultDevice = devices.find((device) => device.deviceId === "default");
  const options = devices.filter((device) => device.deviceId !== "default");

  return <div className="account-dock-wrap" ref={dockRef}>
    {menu && <section className="audio-popover" aria-label={menu === "input" ? "Thiết bị đầu vào" : "Thiết bị đầu ra"}>
      <div className="audio-popover-head"><strong>{menu === "input" ? "Thiết bị đầu vào" : "Thiết bị đầu ra"}</strong><small>{menu === "input" && props.microphoneOn ? "Tắt mic để đổi thiết bị" : "Chọn thiết bị âm thanh"}</small></div>
      <div className="device-list" role="radiogroup" aria-label={menu === "input" ? "Chọn microphone" : "Chọn loa"}>
        <label className="device-option"><input ref={firstOptionRef} type="radio" name={`audio-${menu}`} checked={selected === ""} disabled={menu === "input" && props.microphoneOn} onChange={() => { choose(""); setMenu(null); }} /><span><strong>Mặc định của hệ thống</strong><small>{defaultDevice?.label || (menu === "input" ? "Microphone mặc định" : "Loa mặc định")}</small></span></label>
        {options.map((device, index) => <label className="device-option" key={device.deviceId}><input type="radio" name={`audio-${menu}`} checked={selected === device.deviceId} disabled={menu === "input" && props.microphoneOn} onChange={() => { choose(device.deviceId); setMenu(null); }} /><span><strong>{device.label || `${menu === "input" ? "Microphone" : "Loa"} ${index + 1}`}</strong></span></label>)}
      </div>
      {menu === "input" && <div className="input-level"><span>Mức âm lượng đầu vào</span><meter min="0" max="100" value={props.micLevel} aria-label="Mức âm thanh microphone" /></div>}
    </section>}
    <div className="account-dock">
      <button type="button" className="account-identity" aria-label="Bạn bè & hồ sơ" onClick={props.onOpenSocial}>
        <span className="account-avatar-wrap">{props.user?.avatarData ? <img src={props.user.avatarData} alt="" /> : <span className="account-avatar-fallback">{props.user?.displayName?.slice(0, 1).toUpperCase() || "?"}</span>}<span className={`account-presence ${props.connected ? "is-online" : ""}`} /></span>
        <span className="account-identity-text"><strong>{props.user?.displayName || "Tài khoản"}</strong><small>{props.connected ? "Đang trong phòng" : "Sẵn sàng"}</small></span>
        {props.unread > 0 && <span className="account-unread" aria-label={`${props.unread} thông báo chưa đọc`}>{Math.min(props.unread, 99)}</span>}
      </button>
      <div className="account-controls">
        <button type="button" className={`dock-icon ${props.microphoneOn ? "is-active" : ""}`} onClick={props.onToggleMicrophone} disabled={!props.canPublish} aria-label={props.microphoneOn ? "Micrô đang bật, nhấn để tắt" : "Micrô đang tắt, nhấn để bật"} aria-pressed={props.microphoneOn} title={props.microphoneOn ? "Tắt mic" : "Bật mic"}><UiIcon name={props.microphoneOn ? "mic" : "micOff"} /></button>
        <button ref={inputButtonRef} type="button" className="dock-chevron" aria-label="Chọn microphone" aria-expanded={menu === "input"} onClick={() => setMenu(menu === "input" ? null : "input")}><UiIcon name="chevron" size={14} /></button>
        <button type="button" className={`dock-icon ${props.speakerMuted ? "is-muted" : ""}`} aria-label={props.speakerMuted ? "Bật loa" : "Tắt loa"} aria-pressed={props.speakerMuted} title={props.speakerMuted ? "Bật âm thanh người khác" : "Tắt âm thanh người khác"} onClick={props.onToggleSpeaker}><UiIcon name={props.speakerMuted ? "volumeOff" : "volume"} /></button>
        <button ref={outputButtonRef} type="button" className="dock-chevron" aria-label="Mở danh sách loa" aria-expanded={menu === "output"} onClick={() => setMenu(menu === "output" ? null : "output")}><UiIcon name="chevron" size={14} /></button>
        <button type="button" className="dock-icon" aria-label="Cài đặt hồ sơ" onClick={props.onOpenSocial}><UiIcon name="settings" /></button>
      </div>
    </div>
  </div>;
}
