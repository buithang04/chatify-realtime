import * as mediasoup from "mediasoup";
import type {
  Consumer,
  DtlsParameters,
  Producer,
  RtpCapabilities,
  RtpParameters,
  Router,
  WebRtcTransport,
  Worker
} from "mediasoup/types";
import type { MediaConfig } from "./config.js";

const mediaCodecs = [
  { kind: "audio" as const, mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  { kind: "video" as const, mimeType: "video/VP8", clockRate: 90000, rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }, { type: "ccm", parameter: "fir" }, { type: "goog-remb" }, { type: "transport-cc" }] },
  { kind: "video" as const, mimeType: "video/H264", clockRate: 90000, parameters: { "packetization-mode": 1, "profile-level-id": "42e01f", "level-asymmetry-allowed": 1 }, rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }, { type: "ccm", parameter: "fir" }, { type: "goog-remb" }, { type: "transport-cc" }] }
];

export class MediaRuntime {
  private constructor(private readonly worker: Worker, private readonly config: MediaConfig) {}
  private readonly routers = new Map<string, Router>();
  private readonly transports = new Map<string, WebRtcTransport>();
  private readonly producers = new Map<string, Producer>();
  private readonly consumers = new Map<string, Consumer>();
  private readonly transportOwners = new Map<string, string>();
  private readonly producerOwners = new Map<string, string>();
  private readonly consumerOwners = new Map<string, string>();
  private readonly transportCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private iceFailureCount = 0;
  private dtlsFailureCount = 0;

  static async create(config: MediaConfig): Promise<MediaRuntime> {
    const worker = await mediasoup.createWorker({ logLevel: "warn", rtcMinPort: config.rtcMinPort, rtcMaxPort: config.rtcMaxPort });
    const runtime = new MediaRuntime(worker, config);
    worker.on("died", (error) => {
      console.error("mediasoup worker died", { pid: worker.pid, error });
      runtime.close();
      process.exit(1);
    });
    return runtime;
  }

  get pid(): number { return this.worker.pid; }
  get transportCount(): number { return this.transports.size; }
  get producerCount(): number { return this.producers.size; }
  get consumerCount(): number { return this.consumers.size; }
  get iceFailures(): number { return this.iceFailureCount; }
  get dtlsFailures(): number { return this.dtlsFailureCount; }

  async createRouter(roomId: string): Promise<Router> {
    const existing = this.routers.get(roomId);
    if (existing && !existing.closed) return existing;
    const router = await this.worker.createRouter({ mediaCodecs, appData: { roomId } });
    router.on("workerclose", () => this.routers.delete(roomId));
    this.routers.set(roomId, router);
    return router;
  }

  getRouter(routerId: string): Router {
    const router = [...this.routers.values()].find((candidate) => candidate.id === routerId);
    if (!router || router.closed) throw new Error("ROUTER_NOT_FOUND");
    return router;
  }

  async createTransport(routerId: string, ownerId = ""): Promise<WebRtcTransport> {
    const router = this.getRouter(routerId);
    const transport = await router.createWebRtcTransport({
      listenInfos: [
        { protocol: "udp", ip: "0.0.0.0", announcedAddress: this.config.announcedAddress },
        { protocol: "tcp", ip: "0.0.0.0", announcedAddress: this.config.announcedAddress }
      ],
      appData: { routerId, roomId: router.appData.roomId }
    });
    this.transports.set(transport.id, transport);
    this.transportOwners.set(transport.id, ownerId);
    transport.on("routerclose", () => this.removeTransport(transport.id));
    transport.on("dtlsstatechange", (state) => {
      if (state === "connected") this.clearTransportCleanupTimer(transport.id);
      if (state === "failed") this.dtlsFailureCount += 1;
      if (state === "failed" || state === "closed") this.closeTransportSafely(transport.id);
    });
    transport.on("icestatechange", (state) => {
      if (state === "connected" || state === "completed") this.clearTransportCleanupTimer(transport.id);
      if (state === "disconnected") this.iceFailureCount += 1;
      if (state === "disconnected" || state === "closed") this.scheduleTransportCleanup(transport.id, 5_000);
    });
    this.scheduleTransportCleanup(transport.id, this.config.transportIdleTimeoutMs);
    return transport;
  }

  closeTransport(id: string): void {
    const transport = this.getTransport(id);
    this.closeTransportSafely(transport.id);
  }

  private clearTransportCleanupTimer(id: string): void {
    const timer = this.transportCleanupTimers.get(id);
    if (timer) clearTimeout(timer);
    this.transportCleanupTimers.delete(id);
  }

  private scheduleTransportCleanup(id: string, delayMs: number): void {
    this.clearTransportCleanupTimer(id);
    this.transportCleanupTimers.set(id, setTimeout(() => this.closeTransportSafely(id), delayMs));
  }

  private removeTransport(id: string): void {
    this.clearTransportCleanupTimer(id);
    this.transports.delete(id);
    this.transportOwners.delete(id);
  }

  private closeTransportSafely(id: string): void {
    const transport = this.transports.get(id);
    if (transport && !transport.closed) transport.close();
    this.removeTransport(id);
  }

  getTransport(id: string): WebRtcTransport {
    const transport = this.transports.get(id);
    if (!transport || transport.closed) throw new Error("TRANSPORT_NOT_FOUND");
    return transport;
  }

  async produce(transportId: string, kind: "audio" | "video", rtpParameters: RtpParameters, appData: unknown, ownerId = ""): Promise<Producer> {
    const transport = this.getTransport(transportId);
    const producer = await transport.produce({ kind, rtpParameters, appData: { ...(appData ?? {}) as Record<string, unknown>, roomId: transport.appData.roomId } });
    this.producers.set(producer.id, producer);
    this.producerOwners.set(producer.id, ownerId);
    producer.on("transportclose", () => this.producers.delete(producer.id));
    producer.on("transportclose", () => this.producerOwners.delete(producer.id));
    return producer;
  }

  getProducer(id: string): Producer {
    const producer = this.producers.get(id);
    if (!producer || producer.closed) throw new Error("PRODUCER_NOT_FOUND");
    return producer;
  }

  listProducerIds(roomId: string): string[] {
    return [...this.producers.values()]
      .filter((producer) => !producer.closed && String(producer.appData.roomId ?? "") === roomId)
      .map((producer) => producer.id);
  }

  async pauseProducer(id: string): Promise<void> { await this.getProducer(id).pause(); }
  async resumeProducer(id: string): Promise<void> { await this.getProducer(id).resume(); }
  closeProducer(id: string): void {
    this.getProducer(id).close();
    this.producers.delete(id);
    this.producerOwners.delete(id);
  }
  async setMaxIncomingBitrate(id: string, bitrate: number): Promise<void> { await this.getTransport(id).setMaxIncomingBitrate(bitrate); }
  routerRoomId(id: string): string { return String(this.getRouter(id).appData.roomId ?? ""); }
  transportRoomId(id: string): string { return String(this.getTransport(id).appData.roomId ?? ""); }
  transportOwner(id: string): string { this.getTransport(id); return this.transportOwners.get(id) ?? ""; }
  producerOwner(id: string): string { this.getProducer(id); return this.producerOwners.get(id) ?? ""; }
  producerRoomId(id: string): string { return String(this.getProducer(id).appData.roomId ?? ""); }
  consumerOwner(id: string): string { this.getConsumer(id); return this.consumerOwners.get(id) ?? ""; }
  consumerRoomId(id: string): string { return String(this.getConsumer(id).appData.roomId ?? ""); }

  async consume(transportId: string, producerId: string, rtpCapabilities: RtpCapabilities, ownerId = ""): Promise<Consumer> {
    const transport = this.getTransport(transportId);
    const producer = this.getProducer(producerId);
    const router = this.getRouter(String(transport.appData.routerId));
    if (!router.canConsume({ producerId, rtpCapabilities })) throw new Error("CANNOT_CONSUME");
    const consumer = await transport.consume({ producerId: producer.id, rtpCapabilities, paused: true, appData: { roomId: transport.appData.roomId, source: producer.appData.source } });
    this.consumers.set(consumer.id, consumer);
    this.consumerOwners.set(consumer.id, ownerId);
    consumer.on("transportclose", () => this.consumers.delete(consumer.id));
    consumer.on("transportclose", () => this.consumerOwners.delete(consumer.id));
    return consumer;
  }

  getConsumer(id: string): Consumer {
    const consumer = this.consumers.get(id);
    if (!consumer || consumer.closed) throw new Error("CONSUMER_NOT_FOUND");
    return consumer;
  }

  async connectTransport(id: string, dtlsParameters: DtlsParameters): Promise<void> {
    await this.getTransport(id).connect({ dtlsParameters });
  }

  close(): void {
    for (const consumer of this.consumers.values()) consumer.close();
    for (const producer of this.producers.values()) producer.close();
    for (const transport of this.transports.values()) transport.close();
    for (const timer of this.transportCleanupTimers.values()) clearTimeout(timer);
    this.transportCleanupTimers.clear();
    this.transports.clear();
    this.transportOwners.clear();
    for (const router of this.routers.values()) router.close();
    this.worker.close();
  }
}
