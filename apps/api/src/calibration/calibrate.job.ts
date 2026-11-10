// calibrate.crc (CONTRACTS-L2 4.3, 5.4): build the calibration set, compute the thresholds,
// store them with the current defender version and make them active.
//
// The set: every arena trial of a train-split run that reached a checkout. Each order's fused
// score s comes from its immune-arm verification's checks (recomputed, not trusted from the trial
// row); its label is the oracle's (did the agent buy the poisoned listing?). A checkout of a
// benign listing in a tenant is a benign order. Orders with any deterministic fail are excluded:
// they are VOIDed before the gate ever sees them.
import { TrialResult, type CalibrationResult } from "@poi/shared";
import type { PrismaClient } from "../lib/prisma";
import { parseChecks } from "../lib/mappers";
import type { ArenaEmitter } from "../realtime/arena-emitter";
import { getDefender, setActiveCalibration } from "../immune/defender";
import { insertCalibration } from "./calibration.repo";
import { computeCrc, crcCurve, type CalItem } from "./crc";
import { fuse, hasDeterministicFail, stageScores } from "./fuse";

export interface CalibrateDeps {
  prisma: () => PrismaClient;
  emitter: ArenaEmitter;
  benignVoidQuantile: number;
}

/** Calibration items from the train split's arena trials. */
export async function buildCalibrationSet(db: PrismaClient): Promise<CalItem[]> {
  const trials = await db.arenaTrial.findMany({
    where: {
      genome: { split: "train" },
      verdictImmune: { not: null },
    },
    include: { genome: { select: { family: true } } },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });
  const results = trials
    .map((t) => ({ r: TrialResult.safeParse(t.result), family: t.genome.family }))
    .flatMap(({ r, family }) =>
      r.success && r.data.orderId && r.data.valid ? [{ t: r.data, family }] : [],
    );
  const orderIds = results.map((x) => x.t.orderId!);
  const verifications = await db.verification.findMany({
    where: { orderId: { in: orderIds }, status: "DONE" },
    select: { orderId: true, config: true, checks: true },
  });
  const immuneChecks = new Map<string, ReturnType<typeof parseChecks>>();
  for (const v of verifications)
    if ((v.config as { immune?: boolean } | null)?.immune)
      immuneChecks.set(v.orderId, parseChecks(v.checks));

  return results.flatMap(({ t, family }) => {
    const checks = immuneChecks.get(t.orderId!);
    if (!checks || hasDeterministicFail(checks)) return [];
    return [
      {
        s: fuse(stageScores(checks)),
        violating: t.chosenPoison,
        family: family as CalItem["family"],
      },
    ];
  });
}

/** POST /api/calibration/run and the nightly cron. Throws NeedMoreData on a set too small for alpha. */
export async function runCalibration(
  deps: CalibrateDeps,
  alpha: number,
): Promise<CalibrationResult> {
  const db = deps.prisma();
  const items = await buildCalibrationSet(db);
  const { noAttacks: _noAttacks, ...result } = computeCrc(items, alpha, deps.benignVoidQuantile);
  const { version } = await getDefender(db);
  const stored = await insertCalibration(db, result, version);
  await setActiveCalibration(db, stored.id);
  deps.emitter.calibration({
    calibrationId: stored.id,
    alpha: stored.alpha,
    lambdaAsk: stored.lambdaAsk,
    lambdaVoid: stored.lambdaVoid,
  });
  return stored;
}

export async function calibrationCurve(deps: CalibrateDeps) {
  return crcCurve(await buildCalibrationSet(deps.prisma()), deps.benignVoidQuantile);
}
