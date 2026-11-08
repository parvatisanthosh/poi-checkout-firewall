import type { Server as HttpServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import { Emitter as RedisEmitter } from "@socket.io/redis-emitter";
import { Redis } from "ioredis";
import { Server } from "socket.io";
import {
  EVENTS,
  LIVE_NAMESPACE,
  orderRoom,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "@poi/shared";
import { roomEmitter, type Emitter } from "./emitter";

const ORDER_ID = /^[\w-]{1,64}$/;

/**
 * Socket.IO on the API's HTTP server: namespace /live, clients `subscribe` to `order:<id>`.
 * With Redis, the redis adapter lets a separate worker process emit into these rooms.
 */
export function attachSocketServer(
  httpServer: HttpServer,
  opts: { origins: string[]; redisUrl?: string },
) {
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: opts.origins },
    serveClient: false,
  });
  const closers: Array<() => void> = [];
  if (opts.redisUrl) {
    const pub = new Redis(opts.redisUrl, { maxRetriesPerRequest: null });
    const sub = pub.duplicate();
    pub.on("error", () => {});
    sub.on("error", () => {});
    io.adapter(createAdapter(pub, sub));
    closers.push(
      () => pub.disconnect(),
      () => sub.disconnect(),
    );
  }
  io.of(LIVE_NAMESPACE).on("connection", (socket) => {
    socket.on(EVENTS.subscribe, (p) => {
      if (p && typeof p.orderId === "string" && ORDER_ID.test(p.orderId))
        void socket.join(orderRoom(p.orderId));
    });
  });
  const emitter: Emitter = roomEmitter(io);
  return {
    io,
    emitter,
    close: async () => {
      await io.close();
      closers.forEach((c) => c());
    },
  };
}

/** For the standalone worker: publish into the API's rooms through Redis. */
export function redisEmitter(redisUrl: string): { emitter: Emitter; close: () => void } {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  redis.on("error", () => {});
  const e = new RedisEmitter<ServerToClientEvents>(redis);
  return { emitter: roomEmitter(e as never), close: () => redis.disconnect() };
}
