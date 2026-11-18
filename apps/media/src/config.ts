export interface MediaConfig {
  httpPort: number;
  rtcMinPort: number;
  rtcMaxPort: number;
  transportIdleTimeoutMs: number;
  announcedAddress?: string;
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
}

export function mediaConfig(env: NodeJS.ProcessEnv = process.env): MediaConfig {
  const httpPort = positiveInt(env.MEDIA_HTTP_PORT, 3002);
  const rtcMinPort = positiveInt(env.RTC_MIN_PORT, 40000);
  const rtcMaxPort = positiveInt(env.RTC_MAX_PORT, 40020);
  const transportIdleTimeoutMs = positiveMilliseconds(env.MEDIA_TRANSPORT_IDLE_TIMEOUT_MS, 60_000);
  if (rtcMaxPort < rtcMinPort) throw new Error("RTC_MAX_PORT must be >= RTC_MIN_PORT");
  const iceServers = [];
  if (env.RTC_STUN_URL) iceServers.push({ urls: env.RTC_STUN_URL });
  if (env.RTC_TURN_URL && env.RTC_TURN_USERNAME && env.RTC_TURN_CREDENTIAL) {
    iceServers.push({ urls: env.RTC_TURN_URL, username: env.RTC_TURN_USERNAME, credential: env.RTC_TURN_CREDENTIAL });
  }
  validateProductionMediaConfig(env, iceServers.length > 0);
  return { httpPort, rtcMinPort, rtcMaxPort, transportIdleTimeoutMs, announcedAddress: env.RTC_ANNOUNCED_ADDRESS || undefined, iceServers };
}

export function validateProductionMediaConfig(env: NodeJS.ProcessEnv, hasIceServer = Boolean(env.RTC_STUN_URL || env.RTC_TURN_URL)): void {
  if ((env.APP_ENV ?? "local").toLowerCase() !== "production") return;
  if ((env.JWT_SECRET ?? "").length < 32) throw new Error("JWT_SECRET must contain at least 32 characters in production");
  if ((env.INTERNAL_SERVICE_TOKEN ?? "").length < 32) throw new Error("INTERNAL_SERVICE_TOKEN must contain at least 32 characters in production");
  const cors = (env.MEDIA_CORS_ORIGIN ?? "").trim();
  if (!cors || cors === "*" || cors.includes("*")) throw new Error("MEDIA_CORS_ORIGIN must be explicit in production");
  const announced = (env.RTC_ANNOUNCED_ADDRESS ?? "").trim().toLowerCase();
  if (!announced || announced === "localhost" || announced === "127.0.0.1" || announced === "::1") throw new Error("RTC_ANNOUNCED_ADDRESS must be public in production");
  if (!env.RTC_TURN_URL || !env.RTC_TURN_USERNAME || !env.RTC_TURN_CREDENTIAL || !hasIceServer) throw new Error("public TURN configuration is required in production");
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("port must be an integer between 1 and 65535");
  return parsed;
}

function positiveMilliseconds(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3_600_000) throw new Error("MEDIA_TRANSPORT_IDLE_TIMEOUT_MS must be between 1 and 3600000");
  return parsed;
}
