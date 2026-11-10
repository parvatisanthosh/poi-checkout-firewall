import { createServer } from "node:http";
import { arenaJobDeps, buildDeps, createApp } from "./app";
import { createBullArenaQueue, startArenaWorkers } from "./arena/queue";
import { env } from "./env";
import { logger } from "./lib/logger";
import { disconnectPrisma } from "./lib/prisma";
import { createBullQueue, startBullWorker } from "./lib/queue";
import { disconnectRedis } from "./lib/redis";
import { attachSocketServer } from "./realtime/socket";
import { markVerificationFailed, runVerification } from "./verifier/pipeline";

const deps = buildDeps();
// The app must be the server's request handler BEFORE socket.io attaches, so socket.io can
// claim /socket.io/* and pass everything else through.
const server = createServer(createApp(deps));
const origins = env.WEB_ORIGIN.split(",").map((o) => o.trim());
const sockets = attachSocketServer(server, { origins, redisUrl: env.REDIS_URL });
deps.emitter = sockets.emitter;
deps.arenaEmitter = sockets.arenaEmitter;

const closers: Array<() => Promise<unknown>> = [sockets.close];
if (env.REDIS_URL) {
  const queue = createBullQueue(env.REDIS_URL);
  deps.queue = queue;
  closers.push(queue.close);
  if (env.WORKER_INLINE) {
    const worker = startBullWorker(
      env.REDIS_URL,
      (id) => runVerification(deps, id),
      (id, err) => markVerificationFailed(deps, id, err),
      env.VERIFY_CONCURRENCY,
    );
    closers.push(worker.close);
    const arena = startArenaWorkers(env.REDIS_URL, arenaJobDeps(deps), env.ARENA_CONCURRENCY);
    closers.push(arena.close);
  }
  const arenaQueue = createBullArenaQueue(env.REDIS_URL);
  deps.arenaQueue = arenaQueue;
  closers.push(arenaQueue.close);
  logger.info(
    `verify + arena queues: BullMQ (${env.WORKER_INLINE ? "workers in this process" : "separate worker process"})`,
  );
} else {
  logger.warn(
    "REDIS_URL not set: verifications and arena runs run in-process without a durable queue",
  );
}

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    logger.fatal(`port ${env.API_PORT} is busy -- is the mock API (pnpm mock:api) running?`);
    process.exit(1);
  }
  throw err;
});

server.listen(env.API_PORT, () => {
  logger.info(`POI API on http://localhost:${env.API_PORT}/api`);
});

function shutdown(signal: string) {
  logger.info(`${signal}: shutting down`);
  setTimeout(() => process.exit(1), 8000).unref();
  void Promise.allSettled(closers.map((c) => c()))
    .then(() => Promise.allSettled([disconnectPrisma(), disconnectRedis()]))
    .then(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
