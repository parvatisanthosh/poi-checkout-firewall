// Calibration persistence (CONTRACTS-L2 4.2). The stored result's id/createdAt are the row's.
import { CalibrationResult } from "@poi/shared";
import type { Prisma, PrismaClient } from "../lib/prisma";

type Db = PrismaClient | Prisma.TransactionClient;
const json = (v: unknown) => v as Prisma.InputJsonValue;

type Row = { id: string; result: unknown; createdAt: Date };
const toResult = (r: Row): CalibrationResult =>
  CalibrationResult.parse({
    ...(r.result as object),
    id: r.id,
    createdAt: r.createdAt.toISOString(),
  });

/** Store a calibration computed at `defenderVersion`. Does NOT make it active (see defender.ts). */
export async function insertCalibration(
  db: Db,
  result: Omit<CalibrationResult, "id" | "createdAt">,
  defenderVersion: number,
): Promise<CalibrationResult> {
  const row = await db.calibration.create({
    data: { alpha: result.alpha, result: json(result), defenderVersion },
  });
  const full = CalibrationResult.parse({
    ...result,
    id: row.id,
    createdAt: row.createdAt.toISOString(),
  });
  await db.calibration.update({ where: { id: row.id }, data: { result: json(full) } });
  return full;
}

export async function getCalibration(db: Db, id: string): Promise<CalibrationResult | null> {
  const r = await db.calibration.findUnique({ where: { id } });
  return r ? toResult(r) : null;
}

export async function latestCalibration(db: Db): Promise<CalibrationResult | null> {
  const r = await db.calibration.findFirst({ orderBy: { createdAt: "desc" } });
  return r ? toResult(r) : null;
}

/** The calibration the defender currently uses (DefenderState.activeCalibrationId). */
export async function activeCalibration(db: Db): Promise<CalibrationResult | null> {
  const s = await db.defenderState.findUnique({ where: { id: 1 } });
  return s?.activeCalibrationId ? getCalibration(db, s.activeCalibrationId) : null;
}
