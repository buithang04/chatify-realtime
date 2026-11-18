import { createClient } from "redis";

export type SignalClaim = { duplicate: boolean; sequence: number };

export interface SignalState {
  claim(roomId: string, eventId: string): Promise<SignalClaim>;
  close(): Promise<void>;
}

export class LocalSignalState implements SignalState {
  private readonly sequences = new Map<string, number>();
  private readonly events = new Map<string, Map<string, number>>();

  async claim(roomId: string, eventId: string): Promise<SignalClaim> {
    const roomEvents = this.events.get(roomId) ?? new Map<string, number>();
    const existing = roomEvents.get(eventId);
    if (existing !== undefined) return { duplicate: true, sequence: existing };
    const sequence = (this.sequences.get(roomId) ?? 0) + 1;
    this.sequences.set(roomId, sequence);
    roomEvents.set(eventId, sequence);
    if (roomEvents.size > 2048) roomEvents.delete(roomEvents.keys().next().value as string);
    this.events.set(roomId, roomEvents);
    return { duplicate: false, sequence };
  }

  async close(): Promise<void> { return undefined; }
}

const claimScript = `
local existing = redis.call('GET', KEYS[1])
if existing then return {1, existing} end
local sequence = redis.call('INCR', KEYS[2])
redis.call('SET', KEYS[1], sequence, 'EX', ARGV[1])
return {0, sequence}
`;

export async function connectRedisSignalState(): Promise<SignalState | undefined> {
  const address = process.env.REDIS_ADDRESS?.trim();
  const configuredURL = process.env.REDIS_URL?.trim();
  if (!address && !configuredURL) return undefined;
  const password = process.env.REDIS_PASSWORD ?? "";
  const url = configuredURL || `redis://${password ? `:${encodeURIComponent(password)}@` : ""}${address}`;
  const client = createClient({ url });
  client.on("error", (error) => console.error("redis signal state error", error));
  await client.connect();
  return new RedisSignalState(client);
}

class RedisSignalState implements SignalState {
  constructor(private readonly client: ReturnType<typeof createClient>) {}

  async claim(roomId: string, eventId: string): Promise<SignalClaim> {
    const result = await this.client.eval(claimScript, {
      keys: [`chatify:signal:event:${roomId}:${eventId}`, `chatify:signal:sequence:${roomId}`],
      arguments: ["300"]
    }) as [number | string, number | string];
    return { duplicate: Number(result[0]) === 1, sequence: Number(result[1]) };
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.quit();
  }
}
