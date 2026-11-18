import { Device } from "mediasoup-client";
import type { Consumer, DtlsParameters, IceCandidate, IceParameters, MediaKind, RtpParameters, SctpParameters, Transport } from "mediasoup-client/types";

const MEDIA_URL = import.meta.env.VITE_MEDIA_URL ?? "http://localhost:3002";

type RouterResponse = { routerId: string; rtpCapabilities: Record<string, unknown> };
type TransportResponse = {
  transportId: string;
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
  sctpParameters?: SctpParameters;
  iceServers?: RTCIceServer[];
};
type ConsumerResponse = { consumerId: string; producerId: string; kind: MediaKind; source?: "screen" | "camera"; rtpParameters: RtpParameters };
type ProducerListResponse = { producerIds: string[] };

async function mediaRequest<T>(path: string, body: Record<string, unknown>, token: string): Promise<T> {
  const response = await fetch(`${MEDIA_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(payload?.error ?? `Media request failed (${response.status})`);
  return payload as T;
}

async function loadDevice(roomId: string, token: string): Promise<{ device: Device; routerId: string }> {
  const router = await mediaRequest<RouterResponse>("/routers", { roomId }, token);
  const device = new Device();
  await device.load({ routerRtpCapabilities: router.rtpCapabilities });
  return { device, routerId: router.routerId };
}

function connectTransport(transport: Transport, token: string): void {
  transport.on("connect", ({ dtlsParameters }, callback, errback) => {
    mediaRequest(`/transports/${transport.id}/connect`, { dtlsParameters }, token).then(() => callback()).catch(errback);
  });
}

export async function createSendTransport(roomId: string, token: string): Promise<{ device: Device; routerId: string; transport: Transport }> {
  const { device, routerId } = await loadDevice(roomId, token);
  const info = await mediaRequest<TransportResponse>(`/routers/${routerId}/transports`, {}, token);
  const transport = device.createSendTransport({
    id: info.transportId,
    iceParameters: info.iceParameters,
    iceCandidates: info.iceCandidates,
    dtlsParameters: info.dtlsParameters,
    sctpParameters: info.sctpParameters,
    iceServers: info.iceServers,
  });
  connectTransport(transport, token);
  transport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
    mediaRequest<{ producerId: string }>(`/transports/${transport.id}/produce`, { kind, rtpParameters, appData }, token)
      .then(({ producerId }) => callback({ id: producerId }))
      .catch(errback);
  });
  return { device, routerId, transport };
}

export async function createRecvTransport(roomId: string, device: Device, routerId: string | undefined, token: string): Promise<{ device: Device; routerId: string; transport: Transport }> {
  const session = routerId ? { device, routerId } : await loadDevice(roomId, token);
  const info = await mediaRequest<TransportResponse>(`/routers/${session.routerId}/transports`, {}, token);
  const transport = session.device.createRecvTransport({
    id: info.transportId,
    iceParameters: info.iceParameters,
    iceCandidates: info.iceCandidates,
    dtlsParameters: info.dtlsParameters,
    sctpParameters: info.sctpParameters,
    iceServers: info.iceServers,
  });
  connectTransport(transport, token);
  return { ...session, transport };
}

export async function consume(transport: Transport, device: Device, producerId: string, token: string): Promise<Consumer> {
  const info = await mediaRequest<ConsumerResponse>(`/transports/${transport.id}/consume`, {
    producerId,
    rtpCapabilities: device.recvRtpCapabilities,
  }, token);
  const consumer = await transport.consume({ id: info.consumerId, producerId: info.producerId, kind: info.kind, rtpParameters: info.rtpParameters, appData: { source: info.source } });
  await mediaRequest(`/consumers/${consumer.id}/resume`, {}, token);
  return consumer;
}

export async function closeProducer(producerId: string, token: string): Promise<void> {
  await mediaRequest(`/producers/${producerId}/close`, {}, token);
}

export async function closeTransport(transportId: string, token: string): Promise<void> {
  await mediaRequest(`/transports/${transportId}/close`, {}, token);
}

export async function setMaxIncomingBitrate(transportId: string, bitrate: number, token: string): Promise<void> {
  await mediaRequest(`/transports/${transportId}/max-incoming-bitrate`, { bitrate }, token);
}

export async function listRoomProducers(roomId: string, token: string): Promise<string[]> {
  const result = await mediaRequest<ProducerListResponse>(`/rooms/${encodeURIComponent(roomId)}/producers`, {}, token);
  return result.producerIds;
}
