// Dedicated Layer 2 worker (render.yaml poi-arena-worker): arena.generation / arena.trial,
// immune.mint / immune.promote. No Layer 1 "verify" jobs -- the API keeps those -- so long arena
// runs never slow down a shopper's checkout. Events reach browsers through the Redis emitter.
// Set ARENA_WORKERS_INLINE=false on the API when this runs, so only this process takes arena jobs.
import { arenaJobDeps, buildDeps, immuneWorkerDeps } from "./app";
import { startArenaWorkers } from "./arena/queue";
import { env } from "./env";
import { createBullImmuneQueue, startImmuneWorkers } from "./immune/queue";
import { logger } from "./lib/logger";
import { disconnectPrisma } from "./lib/prisma";
import { createBullQueue } from "./lib/queue";
import { redisEmitter } from "./realtime/socket";

if (!env.REDIS_URL) {
  logger.fatal("REDIS_URL is required for the arena worker");
  process.exit(1);
}

const deps = buildDeps();
const events = redisEmitter(env.REDIS_URL);
deps.emitter = events.emitter;
deps.arenaEmitter = events.arenaEmitter;
// Jobs here enqueue more jobs (immune.promote, and verify jobs never): route them to BullMQ.
deps.queue = createBullQueue(env.REDIS_URL);
deps.immuneQueue = createBullImmuneQueue(env.REDIS_URL);
const arena = startArenaWorkers(env.REDIS_URL, arenaJobDeps(deps), env.ARENA_CONCURRENCY);
const immune = startImmuneWorkers(env.REDIS_URL, immuneWorkerDeps(deps));
logger.info(
  `POI arena worker running (trial concurrency ${env.ARENA_CONCURRENCY}, engine ${env.ARENA_ENGINE})`,
);

async function shutdown() {
  setTimeout(() => process.exit(1), 8000).unref();
  await arena.close();
  await immune.close();
  await deps.immuneQueue.close();
  await deps.queue.close();
  events.close();
  await disconnectPrisma();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
