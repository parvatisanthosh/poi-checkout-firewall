import { Redis } from "ioredis";
import { env } from "../env";

let client: Redis | undefined;

/**
 * Shared Redis connection for app use (health, caches). BullMQ (P8) opens its own
 * connections because it needs maxRetriesPerRequest: null.
 */
export function getRedis(): Redis {
  if (!client) {
    if (!env.REDIS_URL) throw new Error("REDIS_URL is not set (see .env.example)");
    client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    // Without a listener ioredis logs every reconnect failure as an unhandled error.
    client.on("error", () => {});
  }
  return client;
}

export async function disconnectRedis(): Promise<void> {
  client?.disconnect();
  client = undefined;
}
