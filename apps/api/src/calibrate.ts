// Nightly calibration (render.yaml cron poi-calibrate; locally: pnpm --filter @poi/api calibrate).
// Runs calibrate.crc once at CRC_ALPHA and exits. Without enough data it says so and exits 0:
// a missing calibration simply leaves the previous one active.
import { runCalibration } from "./calibration/calibrate.job";
import { NeedMoreData } from "./calibration/crc";
import { env } from "./env";
import { logger } from "./lib/logger";
import { disconnectPrisma, getPrisma } from "./lib/prisma";
import { noopArenaEmitter } from "./realtime/arena-emitter";
import { redisEmitter } from "./realtime/socket";

const events = env.REDIS_URL ? redisEmitter(env.REDIS_URL) : null;
try {
  const cal = await runCalibration(
    {
      prisma: getPrisma,
      emitter: events?.arenaEmitter ?? noopArenaEmitter,
      benignVoidQuantile: env.CRC_BENIGN_VOID_QUANTILE,
    },
    env.CRC_ALPHA,
  );
  logger.info(
    { calibrationId: cal.id, n: cal.n, lambdaAsk: cal.lambdaAsk, lambdaVoid: cal.lambdaVoid },
    `calibration done at alpha ${cal.alpha}: empirical miss ${cal.empiricalMiss.toFixed(3)}, benign ask rate ${cal.benignAskRate.toFixed(3)}`,
  );
} catch (err) {
  if (err instanceof NeedMoreData) logger.warn(err.message);
  else {
    logger.error({ err: (err as Error).message }, "calibration failed");
    process.exitCode = 1;
  }
} finally {
  events?.close();
  await disconnectPrisma();
}
