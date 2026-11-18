import { FormEvent, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { Device } from "mediasoup-client";
import type { Consumer, Producer, Transport } from "mediasoup-client/types";
import { api, getApiUrl, DirectMessage, MediaPolicy, Message, RecentRoom, Room, RoomMember, SuggestedRoom, UserProfile } from "./api";
import { closeProducer, closeTransport, consume, createRecvTransport, createSendTransport, listRoomProducers, setMaxIncomingBitrate } from "./media";
import { SocialHub } from "./SocialHub";
import { AccountDock } from "./AccountDock";
import { RoomLockControl } from "./RoomLockControl";
import { UiIcon } from "./UiIcons";

type Tokens = { accessToken: string };
type CreateRoomMode = "direct" | "group" | "livestream";
type RemoteTile = { producerId: string; stream: MediaStream; kind: "audio" | "video"; source?: "screen" | "camera" };
const activeRoomStorageKey = "chatify:active-room";

function RemoteMediaTile({ tile, outputDeviceId, speakerMuted, featured }: { tile: RemoteTile; outputDeviceId: string; speakerMuted: boolean; featured: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = tile.stream;
    const audio = audioRef.current;
    if (!audio) return;
    audio.srcObject = tile.stream;
    const onPlaying = () => setPlaybackBlocked(false);
    audio.addEventListener("playing", onPlaying);
    void audio.play().catch(() => setPlaybackBlocked(true));
    return () => {
      audio.removeEventListener("playing", onPlaying);
      audio.srcObject = null;
    };
  }, [tile.stream]);
  useEffect(() => {
    const audio = audioRef.current;
    if (audio && "setSinkId" in audio) void audio.setSinkId(outputDeviceId).catch(() => setPlaybackBlocked(true));
  }, [outputDeviceId]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = speakerMuted;
    if (!speakerMuted) void audio.play().catch(() => setPlaybackBlocked(true));
  }, [speakerMuted]);
  async function resumeAudio() {
    try { await audioRef.current?.play(); setPlaybackBlocked(false); }
    catch { setPlaybackBlocked(true); }
  }
  return tile.kind === "video"
    ? <video ref={videoRef} className={`remote-video ${featured ? "featured-screen" : ""}`} autoPlay playsInline aria-label={tile.source === "screen" ? "Màn hình được chia sẻ" : `Video remote ${tile.producerId.slice(0, 8)}`} />
    : <><audio ref={audioRef} autoPlay muted={speakerMuted} aria-label={`Audio remote ${tile.producerId.slice(0, 8)}`} />{playbackBlocked && !speakerMuted && <button className="secondary" type="button" onClick={() => void resumeAudio()}>Bật âm thanh người khác</button>}</>;
}

function screenCaptureError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") return `Trình duyệt từ chối chia sẻ màn hình (${error.name}). Kiểm tra quyền chia sẻ màn hình của trang trong trình duyệt rồi thử lại.`;
    if (error.name === "NotFoundError") return "Không tìm thấy màn hình hoặc cửa sổ có thể chia sẻ.";
    if (error.name === "NotReadableError" || error.name === "AbortError") return "Trình duyệt không thể lấy hình từ màn hình đã chọn. Hãy đóng ứng dụng đang chặn rồi thử lại.";
    if (error.name === "InvalidStateError") return "Không thể mở hộp chọn màn hình lúc này (InvalidStateError). Hãy bấm lại nút Chia sẻ màn hình.";
  }
  return `Không thể mở chức năng chia sẻ màn hình (${error instanceof Error ? error.name : "UnknownError"}).`;
}

function App() {
  const [token, setToken] = useState("");
  const [authChecking, setAuthChecking] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [roomName, setRoomName] = useState("Phòng của tôi");
	const [roomPassword, setRoomPassword] = useState("");
	const [joinPassword, setJoinPassword] = useState("");
	const [createLockOpen, setCreateLockOpen] = useState(false);
	const [joinError, setJoinError] = useState("");
	const [socialOpen, setSocialOpen] = useState(false);
	const [socialUnread, setSocialUnread] = useState(0);
	const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [roomIdInput, setRoomIdInput] = useState("");
  const [roomAction, setRoomAction] = useState<"create" | "join">("create");
  const joinPasswordRef = useRef<HTMLInputElement>(null);
  const [roomMode, setRoomMode] = useState<CreateRoomMode>("group");
  const [room, setRoom] = useState<Room | null>(null);
	const [roomToolsOpen, setRoomToolsOpen] = useState(false);
  const [policy, setPolicy] = useState<MediaPolicy | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [directMessages, setDirectMessages] = useState<DirectMessage[]>([]);
  const [activePeer, setActivePeer] = useState<RoomMember | null>(null);
  const [unreadByPeer, setUnreadByPeer] = useState<Record<string, number>>({});
  const [currentUserId, setCurrentUserId] = useState("");
  const [chatVisible, setChatVisible] = useState(true);
  const [chatToast, setChatToast] = useState<{ text: string; peerId?: string } | null>(null);
  const [stageFullscreen, setStageFullscreen] = useState(false);
  const [screenFit, setScreenFit] = useState<"cover" | "contain">("cover");
  const [roomMembers, setRoomMembers] = useState<RoomMember[]>([]);
  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>([]);
	const [suggestedRooms, setSuggestedRooms] = useState<SuggestedRoom[]>([]);
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);
  const [speakingUserIds, setSpeakingUserIds] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [microphoneOn, setMicrophoneOn] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioInputId, setSelectedAudioInputId] = useState("");
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState("");
  const [micLevel, setMicLevel] = useState(0);
  const [screenSharing, setScreenSharing] = useState(false);
  const [screenActionBusy, setScreenActionBusy] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [remoteTiles, setRemoteTiles] = useState<RemoteTile[]>([]);
  const [roomIdCopied, setRoomIdCopied] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const chatVisibleBeforeFullscreenRef = useRef<boolean | null>(null);
  const chatVisibleRef = useRef(chatVisible);
  chatVisibleRef.current = chatVisible;
  const activePeerRef = useRef(activePeer);
  activePeerRef.current = activePeer;
  const currentUserIdRef = useRef(currentUserId);
  currentUserIdRef.current = currentUserId;
  const roomMembersRef = useRef(roomMembers);
  roomMembersRef.current = roomMembers;
  const toastTimerRef = useRef<number | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const sendTransportRef = useRef<Transport | null>(null);
  const cameraProducerRef = useRef<Producer | null>(null);
  const microphoneProducerRef = useRef<Producer | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const screenProducerRef = useRef<Producer | null>(null);
  const screenActionBusyRef = useRef(false);
  const mediaDeviceRef = useRef<Device | null>(null);
  const routerIdRef = useRef<string | null>(null);
  const recvTransportRef = useRef<Transport | null>(null);
  const recvTransportPromiseRef = useRef<Promise<Transport> | null>(null);
  const remoteConsumersRef = useRef<Consumer[]>([]);
  const seenProducerIdsRef = useRef(new Set<string>());
  const closedProducerIdsRef = useRef(new Set<string>());
  const voiceClearTimersRef = useRef(new Map<string, number>());
  const resumeAttemptedRef = useRef(false);

  useEffect(() => {
    api<{ tokens: Tokens; user: UserProfile }>("/api/v1/auth/refresh", { method: "POST" })
      .then((result) => { if (result?.tokens?.accessToken) { setToken(result.tokens.accessToken); setCurrentUserId(result.user.id); setCurrentUser(result.user); } })
      .catch(() => undefined)
      .finally(() => setAuthChecking(false));
  }, []);

  useEffect(() => {
    if (!token) return;
    const refreshSession = async () => {
      try {
        const result = await api<{ tokens: Tokens; user: UserProfile }>("/api/v1/auth/refresh", { method: "POST" });
        const nextToken = result?.tokens?.accessToken;
        if (!nextToken) return;
        setToken(nextToken);
        setCurrentUserId(result.user.id);
		setCurrentUser(result.user);
        tokenRef.current = nextToken;
        if (socketRef.current) socketRef.current.auth = { token: nextToken };
      } catch {
        // Keep the current session during transient network failures; the next tick retries.
      }
    };
    const timer = window.setInterval(refreshSession, 10 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [token]);

  useEffect(() => {
    if (authChecking || !token || resumeAttemptedRef.current) return;
    resumeAttemptedRef.current = true;
    const savedRoomId = sessionStorage.getItem(activeRoomStorageKey);
    if (!savedRoomId) return;
    void api<{ room: Room }>(`/api/v1/rooms/${encodeURIComponent(savedRoomId)}/members`, { method: "POST" }, token)
      .then(({ room: savedRoom }) => connectToRoom(savedRoom))
      .catch(() => {
        sessionStorage.removeItem(activeRoomStorageKey);
        setError("Phòng trước đó không còn khả dụng.");
      });
  }, [authChecking, token]);

  useEffect(() => {
    if (!token || room) return;
    const refresh = () => { void api<{ rooms: RecentRoom[] }>("/api/v1/rooms/recent", {}, tokenRef.current).then((result) => setRecentRooms(result.rooms)).catch(() => undefined); void api<{ rooms: SuggestedRoom[] }>("/api/v1/rooms/friends", {}, tokenRef.current).then((result) => setSuggestedRooms(result.rooms)).catch(() => undefined); };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [token, room?.id]);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      cameraProducerRef.current?.close();
      microphoneProducerRef.current?.close();
      microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenProducerRef.current?.close();
      sendTransportRef.current?.close();
      remoteConsumersRef.current.forEach((consumer) => consumer.close());
      recvTransportRef.current?.close();
      localStream?.getTracks().forEach((track) => track.stop());
      screenStream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => () => {
    localStream?.getTracks().forEach((track) => track.stop());
  }, [localStream]);

  useEffect(() => () => {
    screenStream?.getTracks().forEach((track) => track.stop());
  }, [screenStream]);

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    if (!room || !navigator.mediaDevices?.enumerateDevices) return;
    const refresh = () => {
      void navigator.mediaDevices.enumerateDevices().then((devices) => {
        setAudioInputs(devices.filter((device) => device.kind === "audioinput"));
        setAudioOutputs(devices.filter((device) => device.kind === "audiooutput"));
      }).catch(() => undefined);
    };
    refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, [room?.id, microphoneOn]);

  useEffect(() => {
    const stream = microphoneStreamRef.current;
    if (!microphoneOn || !stream) { setMicLevel(0); return; }
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let lastSpeaking = false;
    let lastVoiceSentAt = 0;
    void context.resume().catch(() => undefined);
    const timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
      const level = Math.min(100, Math.round(Math.sqrt(sum / samples.length) * 240));
      setMicLevel(level);
      const speaking = level >= 6;
      const now = Date.now();
      if (room && (speaking !== lastSpeaking || (speaking && now - lastVoiceSentAt >= 700))) {
        socketRef.current?.emit("voice:activity", { roomId: room.id, speaking });
        lastSpeaking = speaking;
        lastVoiceSentAt = now;
      }
    }, 250);
    return () => {
      window.clearInterval(timer);
      if (lastSpeaking && room) socketRef.current?.emit("voice:activity", { roomId: room.id, speaking: false });
      void context.close();
    };
  }, [microphoneOn, room?.id]);

  async function consumeRemoteProducer(roomId: string, producerId: string) {
    if (seenProducerIdsRef.current.has(producerId) || closedProducerIdsRef.current.has(producerId)) return;
    seenProducerIdsRef.current.add(producerId);
    try {
      const receiveContext = await getReceiveContext(roomId);
      const consumer = await consume(receiveContext.transport, receiveContext.device, producerId, tokenRef.current);
      if (closedProducerIdsRef.current.has(producerId)) { consumer.close(); return; }
      remoteConsumersRef.current.push(consumer);
      const stream = new MediaStream([consumer.track]);
      setRemoteTiles((current) => [...current, { producerId, stream, kind: consumer.kind, source: consumer.appData.source === "screen" ? "screen" : consumer.appData.source === "camera" ? "camera" : undefined }]);
    } catch {
      seenProducerIdsRef.current.delete(producerId);
      setError("Không thể nhận media từ thành viên khác.");
    }
  }

  function removeRemoteProducer(producerId: string) {
    closedProducerIdsRef.current.add(producerId);
    remoteConsumersRef.current.filter((consumer) => consumer.producerId === producerId).forEach((consumer) => consumer.close());
    remoteConsumersRef.current = remoteConsumersRef.current.filter((consumer) => consumer.producerId !== producerId);
    setRemoteTiles((current) => current.filter((tile) => {
      if (tile.producerId !== producerId) return true;
      tile.stream.getTracks().forEach((track) => track.stop());
      return false;
    }));
  }

  function announceProducerClosed(roomId: string, producerId: string) {
    socketRef.current?.emit("signal", { roomId, eventId: crypto.randomUUID(), kind: "media-producer-closed", data: { producerId } });
  }

  async function getReceiveContext(roomId: string): Promise<{ device: Device; transport: Transport }> {
    if (mediaDeviceRef.current && recvTransportRef.current) return { device: mediaDeviceRef.current, transport: recvTransportRef.current };
    recvTransportPromiseRef.current ??= (async () => {
      const session = await createRecvTransport(roomId, mediaDeviceRef.current ?? new Device(), routerIdRef.current ?? undefined, tokenRef.current);
      mediaDeviceRef.current = session.device;
      routerIdRef.current = session.routerId;
      recvTransportRef.current = session.transport;
      return session.transport;
    })().finally(() => { recvTransportPromiseRef.current = null; });
    const transport = await recvTransportPromiseRef.current;
    return { device: mediaDeviceRef.current!, transport };
  }

  async function submitAuth(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const path = displayName.trim() ? "/api/v1/auth/register" : "/api/v1/auth/login";
      const body = displayName.trim() ? { email, password, displayName } : { email, password };
      if (displayName.trim()) await api(path, { method: "POST", body: JSON.stringify(body) });
      const result = await api<{ tokens: Tokens; user: UserProfile }>("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      setToken(result.tokens.accessToken);
      setCurrentUserId(result.user.id);
	  setCurrentUser(result.user);
    } catch (err) { setError(err instanceof Error ? err.message : "Không thể đăng nhập"); }
    finally { setBusy(false); }
  }

  function addMessage(message: Message) {
    setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message].sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }

  function addDirectMessage(message: DirectMessage) {
    setDirectMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message].sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }

  function showChatToast(text: string, peerId?: string) {
    if (chatVisibleRef.current && !peerId) return;
    setChatToast({ text, peerId });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => { setChatToast(null); toastTimerRef.current = null; }, 2200);
  }

  async function openDirectChat(member: RoomMember) {
    if (!room || member.userId === currentUserId) return;
    activePeerRef.current = member; chatVisibleRef.current = true;
    setActivePeer(member); setDirectMessages([]); setChatVisible(true); setChatToast(null); setDraft("");
    setUnreadByPeer((current) => { const next = { ...current }; delete next[member.userId]; return next; });
    try {
      const result = await api<{ messages: DirectMessage[] }>(`/api/v1/rooms/${encodeURIComponent(room.id)}/direct-messages/${encodeURIComponent(member.userId)}?limit=50`, {}, tokenRef.current);
      if (room.id === sessionStorage.getItem(activeRoomStorageKey)) result.messages.forEach(addDirectMessage);
    } catch (err) { setError(err instanceof Error ? err.message : "Không thể tải tin nhắn riêng."); }
  }

  async function toggleStageFullscreen() {
    try {
      if (document.fullscreenElement === stageRef.current) {
        await document.exitFullscreen();
      } else {
        if (screenSharing || remoteTiles.some((tile) => tile.source === "screen")) {
          chatVisibleBeforeFullscreenRef.current = chatVisibleRef.current;
          chatVisibleRef.current = false;
          setChatVisible(false);
        }
        await stageRef.current?.requestFullscreen();
      }
    } catch {
      if (chatVisibleBeforeFullscreenRef.current !== null) {
        setChatVisible(chatVisibleBeforeFullscreenRef.current);
        chatVisibleBeforeFullscreenRef.current = null;
      }
      setError("Trình duyệt không thể mở chế độ toàn màn hình.");
    }
  }

  useEffect(() => {
    const sync = () => {
      const fullscreen = document.fullscreenElement === stageRef.current;
      setStageFullscreen(fullscreen);
      if (!fullscreen && chatVisibleBeforeFullscreenRef.current !== null) {
        chatVisibleRef.current = chatVisibleBeforeFullscreenRef.current;
        setChatVisible(chatVisibleBeforeFullscreenRef.current);
        chatVisibleBeforeFullscreenRef.current = null;
      }
    };
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  async function closeMediaSession() {
    const producers = [cameraProducerRef.current, microphoneProducerRef.current, screenProducerRef.current].filter((producer) => producer !== null);
    const transports = [sendTransportRef.current, recvTransportRef.current].filter((transport) => transport !== null);
    await Promise.allSettled(producers.map((producer) => closeProducer(producer.id, token)));
    await Promise.allSettled(transports.map((transport) => closeTransport(transport.id, token)));
    producers.forEach((producer) => producer.close());
    cameraProducerRef.current = null; microphoneProducerRef.current = null; screenProducerRef.current = null;
    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop()); microphoneStreamRef.current = null;
    sendTransportRef.current?.close(); sendTransportRef.current = null;
    remoteConsumersRef.current.forEach((consumer) => consumer.close()); remoteConsumersRef.current = [];
    recvTransportRef.current?.close(); recvTransportRef.current = null;
    recvTransportPromiseRef.current = null;
    mediaDeviceRef.current = null; routerIdRef.current = null; seenProducerIdsRef.current.clear(); closedProducerIdsRef.current.clear();
    localStream?.getTracks().forEach((track) => track.stop());
    screenStream?.getTracks().forEach((track) => track.stop());
    remoteTiles.forEach((tile) => tile.stream.getTracks().forEach((track) => track.stop()));
    setLocalStream(null); setScreenStream(null); setRemoteTiles([]); setCameraOn(false); setMicrophoneOn(false); setScreenSharing(false);
    voiceClearTimersRef.current.forEach((timer) => window.clearTimeout(timer)); voiceClearTimersRef.current.clear(); setSpeakingUserIds([]);
  }

  async function leaveCurrentRoom() {
    const previousRoomId = room?.id;
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = null;
    await closeMediaSession();
    if (previousRoomId) await api(`/api/v1/rooms/${encodeURIComponent(previousRoomId)}/members/me`, { method: "DELETE" }, tokenRef.current);
    socketRef.current?.disconnect(); socketRef.current = null; setConnected(false);
    setRoom(null); setPolicy(null); setMessages([]); setDirectMessages([]); setActivePeer(null); setUnreadByPeer({}); setChatToast(null); setRoomMembers([]); setOnlineUserIds([]); setRoomToolsOpen(false);
    if (document.fullscreenElement === stageRef.current) void document.exitFullscreen().catch(() => undefined);
    sessionStorage.removeItem(activeRoomStorageKey);
  }

  async function createRoom(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api<{ room: Room }>("/api/v1/rooms", { method: "POST", body: JSON.stringify({ name: roomName, maxParticipants: roomMode === "direct" ? 2 : 20, mode: roomMode === "direct" ? "group" : roomMode, password: roomPassword }) }, token);
      await connectToRoom(result.room);
    } catch (err) { setError(err instanceof Error ? err.message : "Không thể tạo phòng"); }
    finally { setBusy(false); }
  }

  async function joinRoom(event: FormEvent) {
    event.preventDefault();
    const roomId = roomIdInput.trim();
    await joinRoomById(roomId);
  }

  async function joinRoomById(roomId: string) {
    if (!roomId) return;
    if (room?.id === roomId) { setRoomIdInput(""); return; }
    setBusy(true); setError(""); setJoinError("");
    try {
      const result = await api<{ room: Room }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/members`, { method: "POST", body: JSON.stringify({ password: joinPassword }) }, token);
      await connectToRoom(result.room);
      setRoomIdInput(""); setJoinPassword("");
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : "Không thể tham gia phòng");
      joinPasswordRef.current?.focus();
      void api<{ rooms: RecentRoom[] }>("/api/v1/rooms/recent", {}, tokenRef.current).then((result) => setRecentRooms(result.rooms)).catch(() => undefined);
    }
    finally { setBusy(false); }
  }

  function selectSuggestedRoom(roomId: string, isLocked: boolean) {
    setRoomAction("join");
    setRoomIdInput(roomId);
    setJoinPassword("");
    setJoinError(isLocked ? "Phòng có khóa. Nhập mật khẩu bên dưới để tham gia." : "");
    if (isLocked) requestAnimationFrame(() => joinPasswordRef.current?.focus());
    else void joinRoomById(roomId);
  }

  async function connectToRoom(nextRoom: Room) {
    await leaveCurrentRoom();
    setRoom(nextRoom); setMessages([]); setDirectMessages([]); setActivePeer(null); setUnreadByPeer({}); setChatToast(null); setChatVisible(true); setPolicy(null); setConnected(false); setRoomMembers([]); setOnlineUserIds([]);
	setRoomToolsOpen(false);
    const socket = io(import.meta.env.VITE_SIGNALING_URL ?? "http://localhost:3001", { transports: ["websocket"], auth: { token } });
    let rosterVersion = 0;
    socket.on("connect", () => setConnected(true)); socket.on("disconnect", () => { setConnected(false); setOnlineUserIds([]); setSpeakingUserIds([]); });
    socket.on("room:policy", setPolicy);
    socket.on("presence:members", (snapshot: { roomId: string; userIds: string[] }) => {
      if (snapshot.roomId !== nextRoom.id || !Array.isArray(snapshot.userIds)) return;
      const version = ++rosterVersion;
      setOnlineUserIds(snapshot.userIds.filter((id): id is string => typeof id === "string"));
      setSpeakingUserIds((current) => current.filter((id) => snapshot.userIds.includes(id)));
      void Promise.all([
        api<{ members: RoomMember[] }>(`/api/v1/rooms/${encodeURIComponent(nextRoom.id)}/members`, {}, tokenRef.current),
        api<MediaPolicy>(`/api/v1/rooms/${encodeURIComponent(nextRoom.id)}/media-policy`, {}, tokenRef.current),
      ]).then(([{ members }, nextPolicy]) => {
        if (socketRef.current !== socket || version !== rosterVersion) return;
        setRoomMembers(members);
        setUnreadByPeer((current) => Object.fromEntries(Object.entries(current).filter(([userId]) => members.some((member) => member.userId === userId))));
        setPolicy(nextPolicy);
        setError((current) => current === "Không thể tải danh sách thành viên." ? "" : current);
      }).catch(() => { if (socketRef.current === socket && version === rosterVersion) setError("Không thể tải danh sách thành viên."); });
    });
    socket.on("signal", (signal: { kind?: string; data?: { producerId?: string } }) => {
      if (signal.kind === "media-producer" && signal.data?.producerId) void consumeRemoteProducer(nextRoom.id, signal.data.producerId);
      if (signal.kind === "media-producer-closed" && signal.data?.producerId) removeRemoteProducer(signal.data.producerId);
    });
    socket.on("chat:message", (message: Message) => { addMessage(message); if (message.senderId !== currentUserId) showChatToast("Có tin nhắn mới trong phòng"); });
    socket.on("chat:direct-message", (message: DirectMessage) => {
      if (message.roomId !== nextRoom.id) return;
      addDirectMessage(message);
      if (message.senderId !== currentUserIdRef.current && (activePeerRef.current?.userId !== message.senderId || !chatVisibleRef.current)) {
        setUnreadByPeer((current) => ({ ...current, [message.senderId]: (current[message.senderId] ?? 0) + 1 }));
        const sender = roomMembersRef.current.find((member) => member.userId === message.senderId);
        showChatToast(`Tin nhắn riêng từ ${sender?.displayName ?? "thành viên"}`, message.senderId);
      }
    });
    socket.on("voice:activity", (activity: { roomId?: string; userId?: string; speaking?: boolean }) => {
      if (activity.roomId !== nextRoom.id || typeof activity.userId !== "string") return;
      const previousTimer = voiceClearTimersRef.current.get(activity.userId);
      if (previousTimer) window.clearTimeout(previousTimer);
      voiceClearTimersRef.current.delete(activity.userId);
      setSpeakingUserIds((current) => activity.speaking ? [...new Set([...current, activity.userId!])] : current.filter((id) => id !== activity.userId));
      if (activity.speaking) {
        const timer = window.setTimeout(() => setSpeakingUserIds((current) => current.filter((id) => id !== activity.userId)), 1300);
        voiceClearTimersRef.current.set(activity.userId, timer);
      }
    });
    socketRef.current = socket;
    let initialJoinResolved = false;
    let resolveInitialJoin!: () => void;
    let rejectInitialJoin!: (error: Error) => void;
    const initialJoin = new Promise<void>((resolve, reject) => { resolveInitialJoin = resolve; rejectInitialJoin = reject; });
    socket.on("connect", () => {
      void new Promise<{ ok: boolean; error?: string }>((resolve) => socket.emit("room:join", { roomId: nextRoom.id }, resolve)).then((ack) => {
        if (!ack.ok) {
          if (!initialJoinResolved) rejectInitialJoin(new Error(ack.error ?? "Không thể vào phòng"));
          else setError(ack.error ?? "Không thể khôi phục phòng sau khi kết nối lại.");
          return;
        }
        if (!initialJoinResolved) { initialJoinResolved = true; resolveInitialJoin(); }
      }).catch((error) => { if (!initialJoinResolved) rejectInitialJoin(error instanceof Error ? error : new Error("Không thể vào phòng")); });
    });
    socket.once("connect_error", (error) => rejectInitialJoin(error instanceof Error ? error : new Error("Không thể kết nối signaling")));
    await initialJoin;
    sessionStorage.setItem(activeRoomStorageKey, nextRoom.id);
    try {
      const history = await api<{ messages: Message[] }>(`/api/v1/rooms/${encodeURIComponent(nextRoom.id)}/messages?limit=50`, {}, token);
      history.messages.forEach(addMessage);
      const producerIds = await listRoomProducers(nextRoom.id, token);
      await Promise.all(producerIds.map((producerId) => consumeRemoteProducer(nextRoom.id, producerId)));
    } catch {
      setError("Không thể tải lịch sử tin nhắn hoặc media trong phòng.");
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault(); if (!draft.trim() || !room) return;
    const body = draft.trim(); setDraft("");
    try {
      if (activePeer) {
        const result = await api<{ message: DirectMessage }>(`/api/v1/rooms/${encodeURIComponent(room.id)}/direct-messages/${encodeURIComponent(activePeer.userId)}`, { method: "POST", body: JSON.stringify({ clientMessageId: crypto.randomUUID(), body }) }, token);
        addDirectMessage(result.message);
      } else {
        const result = await api<{ message: Message }>(`/api/v1/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ clientMessageId: crypto.randomUUID(), body }) }, token);
        addMessage(result.message);
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Không thể gửi tin nhắn"); }
  }

  async function toggleCamera() {
    setError("");
    let stream: MediaStream | undefined;
    if (localStream) {
      if (cameraProducerRef.current) void closeProducer(cameraProducerRef.current.id, token).catch(() => undefined);
      if (cameraProducerRef.current && room) announceProducerClosed(room.id, cameraProducerRef.current.id);
      cameraProducerRef.current?.close();
      cameraProducerRef.current = null;
      localStream.getTracks().forEach((track) => track.stop());
      setLocalStream(null);
      setCameraOn(false);
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      if (!room) throw new Error("ROOM_REQUIRED");
      const media = await getSendMedia(room.id);
      mediaDeviceRef.current = media.device; routerIdRef.current = media.routerId;
      sendTransportRef.current = media.transport;
      cameraProducerRef.current = await media.transport.produce({
        track: stream.getVideoTracks()[0],
        appData: { source: "camera", quality: "simulcast" },
        encodings: [
          { rid: "low", scaleResolutionDownBy: 4, maxBitrate: 180_000 },
          { rid: "medium", scaleResolutionDownBy: 2, maxBitrate: 600_000 },
          { rid: "high", scaleResolutionDownBy: 1, maxBitrate: 1_800_000 },
        ],
      });
      socketRef.current?.emit("signal", { roomId: room.id, eventId: crypto.randomUUID(), kind: "media-producer", data: { producerId: cameraProducerRef.current.id, kind: "video" } });
      setLocalStream(stream);
      setCameraOn(true);
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      setError("Không thể bật camera. Hãy cấp quyền camera cho trình duyệt.");
    }
  }

  async function getSendMedia(roomId: string) {
    if (sendTransportRef.current && mediaDeviceRef.current && routerIdRef.current) {
      return { device: mediaDeviceRef.current, routerId: routerIdRef.current, transport: sendTransportRef.current };
    }
    const media = await createSendTransport(roomId, token);
    mediaDeviceRef.current = media.device; routerIdRef.current = media.routerId; sendTransportRef.current = media.transport;
    await setMaxIncomingBitrate(media.transport.id, 10_000_000, token).catch(() => undefined);
    return media;
  }

  async function toggleMicrophone() {
    setError("");
    if (microphoneProducerRef.current) {
      const producer = microphoneProducerRef.current;
      microphoneProducerRef.current = null;
      microphoneStreamRef.current?.getAudioTracks().forEach((track) => { track.onended = null; });
      microphoneStreamRef.current?.getTracks().forEach((track) => track.stop()); microphoneStreamRef.current = null;
      void closeProducer(producer.id, tokenRef.current).catch(() => undefined);
      announceProducerClosed(room?.id ?? "", producer.id);
      producer.close();
      setMicrophoneOn(false); return;
    }
    if (!room) { setError("Hãy vào phòng trước khi bật mic."); return; }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: selectedAudioInputId ? { deviceId: { exact: selectedAudioInputId } } : true, video: false });
    } catch (error) {
      const name = error instanceof Error ? error.name : "UnknownError";
      setError(`Trình duyệt không mở được microphone (${name}). Hãy kiểm tra thiết bị đầu vào và quyền mic.`);
      return;
    }
    try {
      const media = await getSendMedia(room.id);
      const track = stream.getAudioTracks()[0];
      const producer = await media.transport.produce({ track, appData: { source: "microphone" } });
      microphoneProducerRef.current = producer;
      microphoneStreamRef.current = stream;
      track.onended = () => {
        if (microphoneProducerRef.current !== producer) return;
        microphoneProducerRef.current = null; microphoneStreamRef.current = null;
        void closeProducer(producer.id, tokenRef.current).catch(() => undefined);
        announceProducerClosed(room.id, producer.id);
        producer.close(); setMicrophoneOn(false);
        setError("Microphone đã ngắt kết nối. Hãy chọn lại thiết bị đầu vào rồi bật mic.");
      };
      socketRef.current?.emit("signal", { roomId: room.id, eventId: crypto.randomUUID(), kind: "media-producer", data: { producerId: producer.id, kind: "audio" } });
      setMicrophoneOn(true);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      console.error("microphone media publish failed", error);
      setError("Đã mở được mic nhưng không gửi được âm thanh lên máy chủ media. Hãy thử lại.");
    }
  }

  async function toggleScreenShare() {
    if (screenActionBusyRef.current) return;
    screenActionBusyRef.current = true;
    setScreenActionBusy(true);
    setError("");
    try {
      if (screenProducerRef.current) {
        const producer = screenProducerRef.current;
        screenProducerRef.current = null;
        screenStream?.getVideoTracks().forEach((track) => { track.onended = null; });
        screenStream?.getTracks().forEach((track) => track.stop());
        producer.close();
        setScreenStream(null); setScreenSharing(false);
        await closeProducer(producer.id, token).catch(() => undefined);
        announceProducerClosed(room?.id ?? "", producer.id);
        return;
      }
      if (!room) { setError("Hãy vào phòng trước khi chia sẻ màn hình."); return; }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      } catch (error) {
        setError(screenCaptureError(error));
        return;
      }
      try {
        const media = await getSendMedia(room.id);
        const screenTrack = stream.getVideoTracks()[0];
        screenTrack.contentHint = "detail";
        const producer = await media.transport.produce({
          track: screenTrack,
          appData: { source: "screen" },
          encodings: [{ maxBitrate: 8_000_000 }],
        });
        screenProducerRef.current = producer;
        stream.getVideoTracks()[0].onended = () => {
          if (screenProducerRef.current !== producer) return;
          screenProducerRef.current = null;
          void closeProducer(producer.id, token).catch(() => undefined);
          announceProducerClosed(room.id, producer.id);
          producer.close();
          setScreenStream(null); setScreenSharing(false);
        };
        socketRef.current?.emit("signal", { roomId: room.id, eventId: crypto.randomUUID(), kind: "media-producer", data: { producerId: producer.id, kind: "video" } });
        setScreenStream(stream); setScreenSharing(true);
      } catch (error) {
        stream.getTracks().forEach((track) => track.stop());
        console.error("screen share media publish failed", error);
        setError("Không thể kết nối máy chủ media để chia sẻ màn hình. Hãy thử lại sau khi kiểm tra kết nối.");
      }
    } finally {
      screenActionBusyRef.current = false;
      setScreenActionBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await api("/api/v1/auth/logout", { method: "POST" });
      await leaveCurrentRoom();
      setToken("");
	  setCurrentUser(null); setSocialOpen(false); setSuggestedRooms([]);
    } catch { setError("Không thể đăng xuất. Hãy thử lại."); }
    finally { setBusy(false); }
  }

  async function copyRoomId() {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(room.id);
    } catch {
      const input = document.createElement("textarea");
      input.value = room.id;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      let copied = false;
      try { input.select(); copied = document.execCommand("copy"); }
      catch { copied = false; }
      finally { input.remove(); }
      if (!copied) { setError("Không thể sao chép ID. Hãy chọn và sao chép mã phòng hiển thị ở đầu trang."); return; }
    }
    setError("");
    setRoomIdCopied(true);
    window.setTimeout(() => setRoomIdCopied(false), 1800);
  }

  if (authChecking) return <main className="auth-shell"><section className="auth-card"><div className="brand-mark">C</div><p className="eyebrow">CHATIFY REALTIME</p><p className="lede">Đang khôi phục phiên làm việc…</p></section></main>;

  if (!token) return <main className="landing-shell"><section className="landing-hero"><div className="landing-inner"><div className="landing-copy"><p className="landing-brand">Chatify<span className="brand-spark">●</span></p><h1>Gặp nhau ở bất cứ đâu — <span>gần nhau hơn.</span></h1><p className="landing-lede">Gọi video rõ nét, chia sẻ màn hình và trò chuyện trong cùng một không gian. Tạo phòng trong vài giây, mời mọi người vào ngay.</p><a className="primary landing-cta" href="#bat-dau">Bắt đầu ngay <span aria-hidden="true">↗</span></a><p className="landing-caption">Một nơi cho cuộc gọi 1-1, nhóm và livestream.</p></div><div className="landing-visual" aria-hidden="true"><div className="visual-glow" /><div className="meeting-frame"><div className="meeting-top"><span className="meeting-live"><i /> Cuộc gọi đang diễn ra</span><span>•••</span></div><div className="meeting-people"><div className="person-card person-one"><span className="person-avatar">L</span><span className="person-name">Linh · Chủ phòng</span></div><div className="person-card person-two"><span className="person-avatar">M</span><span className="person-name">Minh · Thành viên</span></div></div><div className="meeting-controls"><span>◉</span><span>▣</span><span>♬</span><span className="hangup">⌕</span></div></div><div className="floating-chat"><span className="chat-icon">✦</span><div><strong>Trò chuyện liền mạch</strong><small>“Mọi người nghe rõ chứ?”</small></div></div><div className="floating-signal"><span>●</span> Kết nối ổn định</div></div></div></section><section className="landing-features" aria-label="Điểm nổi bật"><div className="feature-inner"><article><span>01 / GỌI VIDEO</span><h2>Gần nhau hơn</h2><p>Hình ảnh, âm thanh và kết nối trong một phòng riêng.</p></article><article><span>02 / CHIA SẺ</span><h2>Làm việc cùng nhau</h2><p>Chia sẻ màn hình để mọi ý tưởng đều dễ theo dõi.</p></article><article><span>03 / TRÒ CHUYỆN</span><h2>Không bỏ lỡ điều gì</h2><p>Nhắn tin song song trong cuộc gọi hoặc livestream.</p></article></div></section><section className="auth-section" id="bat-dau"><div className="auth-intro"><p className="eyebrow">BẮT ĐẦU VỚI CHATIFY</p><h2>Không gian của bạn<br /><span>đã sẵn sàng.</span></h2><p>Đăng nhập để tiếp tục, hoặc điền tên hiển thị để tạo tài khoản mới.</p></div><div className="auth-card"><div className="auth-card-heading"><span className="brand-mark">C</span><div><p className="eyebrow">CHÀO MỪNG BẠN</p><h2>Vào Chatify</h2></div></div><form onSubmit={submitAuth} className="stack"><label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" /></label><label>Mật khẩu<input type="password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Tối thiểu 12 ký tự" autoComplete={displayName ? "new-password" : "current-password"} /></label><label>Tên hiển thị <span className="muted">(chỉ cần khi đăng ký)</span><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Tên của bạn" autoComplete="name" /></label>{error && <p className="error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? "Đang xử lý…" : displayName ? "Tạo tài khoản" : "Đăng nhập"}</button></form><p className="hint">Đã có tài khoản? Để trống tên hiển thị và đăng nhập.</p></div></section></main>;

  return (
    <main className="app-shell">
      <header className="topbar"><div className="brand"><span className="brand-mark small">C</span><span>Chatify</span></div><div className="top-actions"><span className={`status ${connected ? "online" : ""}`}><span />{connected ? "Đã kết nối" : "Sẵn sàng"}</span><button className="quiet" onClick={signOut} disabled={busy}>Đăng xuất</button></div></header>
      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-content">
          <div><p className="eyebrow">WORKSPACE</p><h2>Phòng của bạn</h2></div>
          {room && <button type="button" className="room-tools-toggle" aria-expanded={roomToolsOpen} onClick={() => setRoomToolsOpen(!roomToolsOpen)}>{roomToolsOpen ? "Ẩn tạo / tham gia phòng" : "+ Tạo / tham gia phòng khác"}</button>}
          {(!room || roomToolsOpen) && <>
          <div className="room-action-tabs" aria-label="Chọn cách vào phòng"><button type="button" aria-pressed={roomAction === "create"} onClick={() => setRoomAction("create")}>Tạo phòng</button><button type="button" aria-pressed={roomAction === "join"} onClick={() => setRoomAction("join")}>Tham gia</button></div>
          {roomAction === "create" && <form onSubmit={createRoom} className="stack compact room-entry-form"><label>Tên phòng<input value={roomName} onChange={(e) => setRoomName(e.target.value)} /></label><label>Kiểu phòng<select value={roomMode} onChange={(e) => setRoomMode(e.target.value as CreateRoomMode)}><option value="direct">Gọi 1-1</option><option value="group">Gọi nhóm</option><option value="livestream">Livestream</option></select></label><button type="button" className={`privacy-toggle ${createLockOpen ? "selected" : ""}`} aria-expanded={createLockOpen} onClick={() => { setCreateLockOpen(!createLockOpen); if (createLockOpen) setRoomPassword(""); }}><UiIcon name="lock" size={17} /><span>{createLockOpen ? "✓ Phòng có khóa" : "+ Đặt khóa phòng"}</span></button>{createLockOpen && <label className="room-password-field">Mật khẩu phòng<input type="password" autoComplete="new-password" required minLength={6} maxLength={72} value={roomPassword} onChange={(e) => setRoomPassword(e.target.value)} placeholder="Tối thiểu 6 ký tự" /><small>Người được mời cần mật khẩu này để vào phòng.</small></label>}<button className="primary" disabled={busy}>{busy ? "Đang tạo…" : "＋ Tạo phòng"}</button></form>}
          {roomAction === "join" && <form onSubmit={joinRoom} className="stack compact room-entry-form join-room-form"><label>Mã phòng<input aria-describedby="room-id-help" value={roomIdInput} onChange={(e) => { setRoomIdInput(e.target.value); setJoinError(""); }} placeholder="Dán ID phòng" /></label><span id="room-id-help" className="muted field-help">Dán ID phòng do người tổ chức gửi.</span><label className="room-password-field join-password-field"><span className="password-field-title"><UiIcon name="lock" size={16} /> Mật khẩu phòng <small>(nếu có)</small></span><input ref={joinPasswordRef} type="password" autoComplete="off" value={joinPassword} onChange={(e) => { setJoinPassword(e.target.value); setJoinError(""); }} placeholder="Nhập mật khẩu phòng có khóa" aria-describedby="join-password-help" /><small id="join-password-help">Phòng không khóa thì để trống ô này.</small></label>{joinError && <p className="join-error" role="alert">{joinError}</p>}<button className="secondary" disabled={busy || !roomIdInput.trim()}>Tham gia phòng</button></form>}
          </>}
		  {!room && suggestedRooms.length > 0 && <section className="recent-rooms" aria-label="Phòng của bạn bè"><h3>Phòng bạn bè</h3><ul>{suggestedRooms.map((suggestion) => <li key={suggestion.id}><button type="button" disabled={busy} onClick={() => selectSuggestedRoom(suggestion.id, suggestion.isLocked)}><strong>{suggestion.isLocked ? "🔒 " : ""}{suggestion.name}</strong><small>{suggestion.friendNames.join(", ")} · {suggestion.activeMemberCount} người trong phòng</small></button></li>)}</ul></section>}
          {!room && recentRooms.length > 0 && <section className="recent-rooms" aria-label="Phòng đã vào gần đây"><h3>Phòng gần đây</h3><ul>{recentRooms.map((recent) => <li key={recent.id}><button type="button" disabled={busy} onClick={() => selectSuggestedRoom(recent.id, recent.isLocked)}><strong>{recent.isLocked ? "🔒 " : ""}{recent.name}</strong><small>{recent.activeMemberCount} người đang trong phòng · {recent.mode === "livestream" ? "Livestream" : "Gọi nhóm"}</small></button></li>)}</ul></section>}
          {room && <section className="member-panel" aria-label="Thành viên trong phòng"><div className="member-panel-head"><h3>Trong phòng</h3><span className="member-count">{roomMembers.filter((member) => onlineUserIds.includes(member.userId)).length}</span></div><ul>{roomMembers.filter((member) => onlineUserIds.includes(member.userId)).map((member) => <li key={member.userId} className={`member-row ${speakingUserIds.includes(member.userId) ? "speaking" : ""}`}><button type="button" className="member-chat-button" disabled={member.userId === currentUserId} onClick={() => void openDirectChat(member)} aria-label={member.userId === currentUserId ? `${member.displayName} (bạn)` : `Nhắn riêng cho ${member.displayName}`}><span className="member-avatar" aria-hidden="true">{member.displayName.trim().slice(0, 1).toUpperCase()}</span><span className="member-details"><strong>{member.displayName}</strong><small>{member.role === "owner" ? "Chủ phòng" : member.role === "moderator" ? "Điều hành" : "Thành viên"}</small></span>{unreadByPeer[member.userId] > 0 && <span className="unread-badge" aria-label={`${unreadByPeer[member.userId]} tin nhắn riêng chưa đọc`}>{Math.min(unreadByPeer[member.userId], 99)}</span>}</button><span className="member-online" aria-label="Đang kết nối" title="Đang kết nối" /></li>)}</ul>{onlineUserIds.length === 0 && <p className="member-empty">Đang cập nhật người trong phòng…</p>}</section>}
          </div>
          <AccountDock user={currentUser} unread={socialUnread} connected={connected} canPublish={!!room && !!policy?.canPublish} microphoneOn={microphoneOn} onToggleMicrophone={() => void toggleMicrophone()} speakerMuted={speakerMuted} onToggleSpeaker={() => setSpeakerMuted((muted) => !muted)} onOpenSocial={() => setSocialOpen(true)} audioInputs={audioInputs} audioOutputs={audioOutputs} selectedAudioInputId={selectedAudioInputId} selectedAudioOutputId={selectedAudioOutputId} onSelectAudioInput={setSelectedAudioInputId} onSelectAudioOutput={setSelectedAudioOutputId} micLevel={micLevel} />
        </aside>
        <section className="content">
          {error && <p className="error banner" role="alert">{error}</p>}
          {!room ? <div className="empty-state"><div className="empty-icon">◌</div><h1>Tạo một phòng để bắt đầu</h1><p>Mọi cuộc trò chuyện bắt đầu bằng một không gian rõ ràng.</p></div> : <>
            <div className="room-head"><div><p className="eyebrow">{room.mode === "livestream" ? "LIVESTREAM" : room.maxParticipants === 2 ? "1-1 CALL" : "GROUP CALL"}</p><h1>{room.name}</h1><div className="room-meta"><p className="muted">ID <span className="room-id">{room.id}</span> · tối đa {room.maxParticipants} người · quyền {policy?.role ?? "đang tải"}</p><button className="copy-room" type="button" onClick={copyRoomId}>{roomIdCopied ? "Đã sao chép" : "Sao chép ID"}</button><span className={`room-permission ${policy?.canPublish ? "" : "is-viewer"}`}>{policy?.canPublish ? "Có quyền phát" : "Chỉ xem"}</span></div></div><div className="room-actions"><RoomLockControl roomId={room.id} isLocked={room.isLocked} isOwner={policy?.role === "owner"} token={token} onChange={(isLocked) => setRoom((current) => current?.id === room.id ? { ...current, isLocked } : current)} /><button className="leave-room" type="button" onClick={() => void leaveCurrentRoom().catch(() => setError("Không thể rời phòng. Hãy thử lại."))}>Rời phòng</button></div></div>
            <div ref={stageRef} className={`stage-grid ${chatVisible ? "" : "chat-hidden"} ${remoteTiles.some((tile) => tile.source === "screen") || screenSharing ? "screen-focused" : ""} ${remoteTiles.some((tile) => tile.source === "screen") ? "remote-screen-focused" : ""} ${screenFit === "cover" ? "screen-cover" : ""}`}>
              <section className="video-stage">
                <div className="stage-toolbar"><span>Media stage</span><div className="stage-actions"><span className="muted">{policy?.canConsume ? "Audio/video ready" : "Đang kiểm tra quyền"}</span>{stageFullscreen && (screenSharing || remoteTiles.some((tile) => tile.source === "screen")) && <button type="button" className="stage-icon screen-fit-toggle" aria-label={screenFit === "cover" ? "Hiện toàn bộ" : "Lấp đầy"} onClick={() => setScreenFit((current) => current === "cover" ? "contain" : "cover")} title={screenFit === "cover" ? "Hiện toàn bộ ảnh, có thể có viền đen" : "Lấp đầy khung, có thể cắt mép ảnh"}>{screenFit === "cover" ? "Hiện toàn bộ" : "Lấp đầy"}</button>}<button type="button" className="stage-icon chat-icon" aria-label={chatVisible ? "Ẩn chat" : "Hiện chat"} onClick={() => { setChatVisible((value) => !value); setChatToast(null); }} title={chatVisible ? "Ẩn chat" : "Hiện chat"}>💬{Object.values(unreadByPeer).reduce((sum, count) => sum + count, 0) > 0 && <span className="unread-badge chat-unread" aria-label="Tin nhắn riêng chưa đọc">{Math.min(Object.values(unreadByPeer).reduce((sum, count) => sum + count, 0), 99)}</span>}</button><button type="button" className="stage-icon" aria-label={stageFullscreen ? "Thoát toàn màn hình" : "Toàn màn hình"} onClick={() => void toggleStageFullscreen()} title={stageFullscreen ? "Thoát toàn màn hình" : "Toàn màn hình"}>{stageFullscreen ? "↙" : "⛶"}</button></div></div>
                <div className={`video-placeholder ${cameraOn || screenSharing || remoteTiles.some((tile) => tile.kind === "video") ? "camera-active has-video" : ""}`}>
                  {cameraOn ? <video ref={localVideoRef} className="local-video" autoPlay muted playsInline aria-label="Preview camera của bạn" /> : !screenSharing && <div className="pulse" />}
                  {screenSharing && <video className="local-video screen-preview" autoPlay muted playsInline aria-label="Preview chia sẻ màn hình" ref={(element) => { if (element) element.srcObject = screenStream; }} />}
                    {remoteTiles.length > 0 && <div className="remote-grid">{remoteTiles.map((tile) => <RemoteMediaTile key={tile.producerId} tile={tile} outputDeviceId={selectedAudioOutputId} speakerMuted={speakerMuted} featured={tile.source === "screen" && tile.producerId === remoteTiles.find((candidate) => candidate.source === "screen")?.producerId} />)}</div>}
                  {chatToast && <div className="chat-toast" role="status"><button type="button" onClick={() => { if (chatToast.peerId) { const member = roomMembers.find((item) => item.userId === chatToast.peerId); if (member) void openDirectChat(member); } else { setActivePeer(null); setChatVisible(true); } setChatToast(null); }}>{chatToast.text}</button></div>}
                  <p>{policy?.canPublish ? (screenSharing ? "Màn hình đang được chia sẻ" : "Bật camera, microphone hoặc chia sẻ màn hình") : "Bạn đang ở chế độ người xem"}</p>
                  <div className="media-controls">
                    <button className="secondary" onClick={toggleCamera} disabled={!policy?.canPublish}>{cameraOn ? "Tắt camera" : "Bật camera"}</button>
                    <button className="secondary" onClick={toggleMicrophone} disabled={!policy?.canPublish}>{microphoneOn ? "Tắt mic" : "Bật mic"}</button>
                    <button className="secondary" onClick={toggleScreenShare} disabled={!policy?.canPublish || screenActionBusy}>{screenSharing ? "Dừng chia sẻ" : "Chia sẻ màn hình"}</button>
                  </div>
                </div>
              </section>
              {chatVisible && <section className="chat-panel"><div className="panel-head"><div><h2>{activePeer ? `Riêng với ${activePeer.displayName}` : "Trò chuyện trong phòng"}</h2><span className="muted">{activePeer ? directMessages.filter((message) => message.senderId === activePeer.userId || message.recipientId === activePeer.userId).length : messages.length} tin nhắn</span></div>{activePeer ? <button type="button" className="chat-back" onClick={() => { setActivePeer(null); setDraft(""); }}>Chat phòng</button> : <span className="live-dot">LIVE</span>}</div><div className="messages" aria-live="polite">{(activePeer ? directMessages.filter((message) => message.senderId === activePeer.userId || message.recipientId === activePeer.userId) : messages).length === 0 ? <p className="muted centered">Chưa có tin nhắn. Hãy bắt đầu cuộc trò chuyện.</p> : (activePeer ? directMessages.filter((message) => message.senderId === activePeer.userId || message.recipientId === activePeer.userId) : messages).map((message) => <article className="message" key={message.id}><div className="avatar">{(roomMembers.find((member) => member.userId === message.senderId)?.displayName ?? "?").slice(0, 1).toUpperCase()}</div><div><strong className="message-author">{roomMembers.find((member) => member.userId === message.senderId)?.displayName ?? "Thành viên"}</strong><p>{message.body}</p><time>{new Date(message.createdAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}</time></div></article>)}</div><form className="message-form" onSubmit={sendMessage}><input aria-label={activePeer ? `Tin nhắn riêng cho ${activePeer.displayName}` : "Tin nhắn"} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={activePeer ? `Nhắn riêng cho ${activePeer.displayName}…` : "Viết tin nhắn…"} /><button aria-label="Gửi tin nhắn" className="send" disabled={!draft.trim()}>→</button></form></section>}
            </div>
          </>}
        </section>
      </div>
      <footer className="footer"><span>API {getApiUrl()}</span><span>Local development · v0.1</span></footer>
	  <SocialHub token={token} user={currentUser} open={socialOpen} onClose={() => setSocialOpen(false)} onProfileChange={setCurrentUser} onUnreadChange={setSocialUnread} />
    </main>
  );
}

export default App;
