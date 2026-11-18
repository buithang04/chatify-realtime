import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import type { Server } from "socket.io";

export async function configureRedisAdapter(io: Server): Promise<() => Promise<void>> {
  const address = process.env.REDIS_ADDRESS?.trim();
  const configuredURL = process.env.REDIS_URL?.trim();
  if (!address && !configuredURL) return async () => undefined;

  const password = process.env.REDIS_PASSWORD ?? "";
  const url = configuredURL || `redis://${password ? `:${encodeURIComponent(password)}@` : ""}${address}`;
  const publisher = createClient({ url });
  const subscriber = publisher.duplicate();
  const reportError = (error: unknown) => console.error("redis adapter error", error);
  publisher.on("error", reportError);
  subscriber.on("error", reportError);
  await Promise.all([publisher.connect(), subscriber.connect()]);
  io.adapter(createAdapter(publisher, subscriber));
  console.log("redis socket.io adapter connected");

  return async () => {
    await Promise.all([
      publisher.isOpen ? publisher.quit() : Promise.resolve(),
      subscriber.isOpen ? subscriber.quit() : Promise.resolve()
    ]);
  };
}
