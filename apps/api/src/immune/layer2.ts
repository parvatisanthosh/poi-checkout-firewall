// Layer 2 inside one verification (CONTRACTS-L2 5.2-5.5), run by the pipeline after the Layer 1
// stages when config.immune or config.conformal is set:
//   1. which defender: a pinned version (frozen evals) or the current one
//   2. immune stage (config.immune): antibody matches + merchant risk, as extra checks
//   3. conformal gate (config.conformal): fuse the stage scores, compare with the calibration
// final verdict = max(lattice over all checks, gate). Nothing here can lower a verdict.
import type { EmbeddingModel } from "ai";
import type {
  AgentTrace,
  CalibrationInfo,
  CheckResult,
  ImmuneMatch,
  Merchant,
  MerchantRiskSnapshot,
  NormalizedOrder,
  Verdict,
  VerifierConfig,
  VerifyRecordL2Fields,
} from "@poi/shared";
import { activeCalibration, getCalibration } from "../calibration/calibration.repo";
import { gateVerdict } from "../calibration/crc";
import { fuse, hasDeterministicFail, stageScores } from "../calibration/fuse";
import type { PrismaClient } from "../lib/prisma";
import { decideVerdict } from "../verifier/lattice";
import { getAntibodySummaries } from "./antibody.repo";
import { getDefender, snapshotDefender } from "./defender";
import { riskKey } from "./risk";
import { runImmuneStage } from "./stage";

/** What a verification stores in Verification.l2 and signs into its evidence record. */
export type L2Record = VerifyRecordL2Fields & {
  /** The verdict Layer 1 alone reached, before the immune stage and the gate. */
  layer1Verdict: Verdict;
  /** The gate's input and output, when it ran. */
  gate?: { s: number; verdict: Verdict };
  /** The verification whose Layer 1 checks this one reused (the arena's immune arm). */
  layer1From?: string;
};

export interface L2Thresholds {
  jaccard: number;
  cosine: number;
  riskAsk: number;
}

export interface Layer2Input {
  config: VerifierConfig;
  order: NormalizedOrder;
  trace: AgentTrace;
  mode: "LIVE" | "DRY_RUN";
  termsText?: string;
  registry: Merchant[];
  /** The checks so far (Layer 1); immune checks are passed to `emit`, which appends to them. */
  checks: CheckResult[];
  emit: (c: CheckResult) => void;
  thresholds: L2Thresholds;
  embeddingModel?: EmbeddingModel;
}

export interface Layer2Output {
  record: L2Record;
  /** CAPTURE when the gate didn't run or didn't object. */
  gate: Verdict;
  matches: ImmuneMatch[];
}

export async function runLayer2(db: PrismaClient, i: Layer2Input): Promise<Layer2Output> {
  const layer1Verdict = decideVerdict(i.checks);
  const pinned = i.config.defenderVersion;
  const snapshot = pinned !== undefined ? await snapshotDefender(db, pinned) : null;
  const defenderVersion = pinned ?? (await getDefender(db)).version;

  let matches: ImmuneMatch[] = [];
  let merchantRisk: MerchantRiskSnapshot | null = null;
  let antibodies: VerifyRecordL2Fields["antibodies"] = [];
  if (i.config.immune) {
    const stage = await runImmuneStage(db, {
      order: i.order,
      trace: i.trace,
      ...(i.termsText ? { termsText: i.termsText } : {}),
      registry: i.registry,
      ...(snapshot ? { antibodyIds: snapshot.antibodyIds } : {}),
      riskKey: riskKey(i.order.merchantId, i.mode),
      thresholds: i.thresholds,
      embeddingModel: i.embeddingModel,
    });
    stage.checks.forEach(i.emit);
    matches = stage.matches;
    merchantRisk = stage.risk;
    antibodies = await getAntibodySummaries(
      db,
      matches.map((m) => m.antibodyId),
    );
  }

  let calibration: CalibrationInfo | null = null;
  let gate: L2Record["gate"];
  if (i.config.conformal) {
    const cal = snapshot
      ? snapshot.calibrationId
        ? await getCalibration(db, snapshot.calibrationId)
        : null
      : await activeCalibration(db);
    if (cal) {
      calibration = {
        alpha: cal.alpha,
        lambdaAsk: cal.lambdaAsk,
        lambdaVoid: cal.lambdaVoid,
        n: cal.n,
        calibrationId: cal.id,
      };
      // Deterministic fails are VOIDed before the gate and were excluded from calibration.
      if (!hasDeterministicFail(i.checks)) {
        const s = fuse(stageScores(i.checks));
        gate = { s, verdict: gateVerdict(s, cal) };
      }
    }
  }

  return {
    record: {
      layer1Verdict,
      defenderVersion,
      ...(i.config.immune ? { immuneMatches: matches, antibodies, merchantRisk } : {}),
      ...(i.config.conformal ? { calibration } : {}),
      ...(gate ? { gate } : {}),
    },
    gate: gate?.verdict ?? "CAPTURE",
    matches,
  };
}

/** One sentence when the gate, not a single check, decided the verdict. */
export function gateSummary(verdict: Verdict, record: L2Record, live: boolean): string {
  const s = record.gate?.s ?? 0;
  const c = record.calibration;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const why = c
    ? `its combined risk score (${s.toFixed(2)}) is above the calibrated ${
        verdict === "VOID" ? "void" : "review"
      } threshold (${(verdict === "VOID" ? c.lambdaVoid : c.lambdaAsk).toFixed(2)}, chosen to miss at most ${pct(c.alpha)} of attacks).`
    : "its combined risk score is above the calibrated threshold.";
  return verdict === "VOID" ? `${live ? "Voided" : "Would void"}: ${why}` : `Needs your OK: ${why}`;
}
