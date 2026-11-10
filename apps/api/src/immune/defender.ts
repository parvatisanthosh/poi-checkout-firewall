// The defender's version (CONTRACTS-L2 4.2 DefenderState). Every change that alters verdicts --
// an antibody promoted or retired -- bumps the version inside one transaction, and the version log
// records the calibration in force, so snapshotDefender(v) can pin an exact past defender for the
// held-out evaluation.
import type { DefenderInfo } from "@poi/shared";
import type { Prisma, PrismaClient } from "../lib/prisma";
import { liveAntibodyIdsAt } from "./antibody.repo";

const DEFENDER_ROW = 1;

export async function getDefender(
  db: PrismaClient | Prisma.TransactionClient,
): Promise<DefenderInfo> {
  const [state, activeAntibodies] = await Promise.all([
    db.defenderState.findUnique({ where: { id: DEFENDER_ROW } }),
    db.antibody.count({ where: { state: "ACTIVE" } }),
  ]);
  if (!state) throw new Error("DefenderState row missing -- run pnpm db:migrate (or pnpm db:seed)");
  return {
    version: state.version,
    activeAntibodies,
    activeCalibrationId: state.activeCalibrationId,
  };
}

/** Lock the single DefenderState row for the rest of the transaction. */
async function lockState(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<Array<{ version: number; activeCalibrationId: string | null }>>`
    SELECT version, "activeCalibrationId" FROM "DefenderState" WHERE id = ${DEFENDER_ROW} FOR UPDATE`;
  if (!rows[0])
    throw new Error("DefenderState row missing -- run pnpm db:migrate (or pnpm db:seed)");
  return rows[0];
}

/**
 * version += 1 and log why, atomically. `change` runs inside the same transaction with the new
 * version (e.g. activateAntibody(tx, id, v)), so a version never exists without its change.
 */
export async function bumpVersion(
  db: PrismaClient,
  reason: string,
  change?: (tx: Prisma.TransactionClient, version: number) => Promise<void>,
): Promise<number> {
  return db.$transaction(async (tx) => {
    const current = await lockState(tx);
    const version = current.version + 1;
    await tx.defenderState.update({ where: { id: DEFENDER_ROW }, data: { version } });
    await tx.defenderVersionLog.create({
      data: { version, reason, calibrationId: current.activeCalibrationId },
    });
    if (change) await change(tx, version);
    return version;
  });
}

/** Make a calibration active for the current version (calibrate.crc). Doesn't bump the version. */
export async function setActiveCalibration(db: PrismaClient, calibrationId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const current = await lockState(tx);
    await tx.defenderState.update({
      where: { id: DEFENDER_ROW },
      data: { activeCalibrationId: calibrationId },
    });
    await tx.defenderVersionLog.update({
      where: { version: current.version },
      data: { calibrationId },
    });
  });
}

export interface DefenderSnapshot {
  version: number;
  antibodyIds: string[];
  calibrationId: string | null;
}

/** Exactly which antibodies and calibration made up defender version `version`. */
export async function snapshotDefender(
  db: PrismaClient | Prisma.TransactionClient,
  version: number,
): Promise<DefenderSnapshot> {
  const log = await db.defenderVersionLog.findUnique({ where: { version } });
  if (!log) throw new Error(`defender version ${version} does not exist`);
  return {
    version,
    antibodyIds: await liveAntibodyIdsAt(db, version),
    calibrationId: log.calibrationId,
  };
}
