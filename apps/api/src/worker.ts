// Standalone verify worker (WORKER_INLINE=false on the API). Pulls "verify" jobs from BullMQ and
// streams events into the API's Socket.IO rooms through the Redis emitter.
import { buildDeps } from "./app";
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
const worker = startBullWorker(
  env.REDIS_URL,
  (id) => runVerification(deps, id),
  (id, err) => markVerificationFailed(deps, id, err),
  env.VERIFY_CONCURRENCY,
);
logger.info(`POI verify worker running (concurrency ${env.VERIFY_CONCURRENCY})`);

async function shutdown() {
  setTimeout(() => process.exit(1), 8000).unref();
  await worker.close();
  events.close();
  await disconnectPrisma();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
