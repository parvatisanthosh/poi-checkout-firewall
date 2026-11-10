// Standalone worker (WORKER_INLINE=false on the API). Pulls "verify" and arena jobs from BullMQ and
// streams events into the API's Socket.IO rooms through the Redis emitter.
import { arenaJobDeps, buildDeps } from "./app";
import { startArenaWorkers } from "./arena/queue";
import { env } from "./env";
import { logger } from "./lib/logger";
import { disconnectPrisma } from "./lib/prisma";
import { startBullWorker } from "./lib/queue";
import { redisEmitter } from "./realtime/socket";
import { markVerificationFailed, runVerification } from "./verifier/pipeline";

if (!env.REDIS_URL) {
  logger.fatal("REDIS_URL is required for the standalone worker");
  process.exit(1);
}

const deps = buildDeps();
const events = redisEmitter(env.REDIS_URL);
deps.emitter = events.emitter;
deps.arenaEmitter = events.arenaEmitter;
const worker = startBullWorker(
  env.REDIS_URL,
  (id) => runVerification(deps, id),
  (id, err) => markVerificationFailed(deps, id, err),
  env.VERIFY_CONCURRENCY,
);
const arena = startArenaWorkers(env.REDIS_URL, arenaJobDeps(deps), env.ARENA_CONCURRENCY);
logger.info(
  `POI worker running (verify concurrency ${env.VERIFY_CONCURRENCY}, arena trials ${env.ARENA_CONCURRENCY})`,
);

async function shutdown() {
  setTimeout(() => process.exit(1), 8000).unref();
  await worker.close();
  await arena.close();
  events.close();
  await disconnectPrisma();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
