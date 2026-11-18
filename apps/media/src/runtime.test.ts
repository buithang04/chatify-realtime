import test from "node:test";
import assert from "node:assert/strict";
import { MediaRuntime } from "./runtime.js";

test("creates router, producer, consumer and resumes consumer", async (t) => {
  const runtime = await MediaRuntime.create({ httpPort: 3002, rtcMinPort: 41000, rtcMaxPort: 41020, transportIdleTimeoutMs: 60_000, iceServers: [] });
  t.after(() => runtime.close());
  const router = await runtime.createRouter("integration-room");
  const sendTransport = await runtime.createTransport(router.id);
  assert.ok(sendTransport.iceCandidates.some((candidate) => candidate.protocol === "udp"));
  assert.ok(sendTransport.iceCandidates.some((candidate) => candidate.protocol === "tcp"));
  const producer = await runtime.produce(sendTransport.id, "audio", {
    codecs: [{ mimeType: "audio/opus", payloadType: 111, clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [] }],
    headerExtensions: [],
    encodings: [{ ssrc: 12345678 }],
    rtcp: { cname: "integration" }
  }, { source: "test" });
  assert.deepEqual(runtime.listProducerIds("integration-room"), [producer.id]);
  const receiveTransport = await runtime.createTransport(router.id);
  const consumer = await runtime.consume(receiveTransport.id, producer.id, router.rtpCapabilities);
  assert.equal(consumer.paused, true);
  await consumer.resume();
  assert.equal(consumer.paused, false);
  await runtime.pauseProducer(producer.id);
  assert.equal(producer.paused, true);
  await runtime.resumeProducer(producer.id);
  assert.equal(producer.paused, false);
  await runtime.setMaxIncomingBitrate(sendTransport.id, 500_000);
  runtime.closeTransport(receiveTransport.id);
  assert.throws(() => runtime.getTransport(receiveTransport.id), /TRANSPORT_NOT_FOUND/);
  const simulcastProducer = await runtime.produce(sendTransport.id, "video", {
    codecs: [{ mimeType: "video/VP8", payloadType: 96, clockRate: 90000, rtcpFeedback: [] }],
    headerExtensions: [],
    encodings: [{ rid: "low", ssrc: 22334455 }, { rid: "high", ssrc: 22334456 }]
  }, { source: "screen", simulcast: true });
  assert.equal(simulcastProducer.kind, "video");
  assert.deepEqual(runtime.listProducerIds("integration-room"), [producer.id, simulcastProducer.id]);
  runtime.closeProducer(producer.id);
  assert.deepEqual(runtime.listProducerIds("integration-room"), [simulcastProducer.id]);
});
