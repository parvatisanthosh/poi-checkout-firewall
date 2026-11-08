// DB rows <-> contract shapes.
import {
  CheckResult,
  type RunMode,
  type SettlementAction,
  type VerificationResult,
} from "@poi/shared";
import { z } from "zod";

export const toDbMode = (m: RunMode) => (m === "live" ? "LIVE" : "DRY_RUN") as "LIVE" | "DRY_RUN";
export const fromDbMode = (m: "LIVE" | "DRY_RUN"): RunMode => (m === "LIVE" ? "live" : "dry-run");

export const parseChecks = (json: unknown) => z.array(CheckResult).catch([]).parse(json);

interface VerificationRow {
  id: string;
  orderId: string;
  status: "QUEUED" | "RUNNING" | "DONE" | "ERROR";
  verdict: "CAPTURE" | "ASK_HUMAN" | "VOID" | null;
  checks: unknown;
  summary: string | null;
  settlement: SettlementAction | null;
  paypalStatus: string | null;
  mode: "LIVE" | "DRY_RUN";
  error?: string | null;
  evidence?: Array<{ hash: string; seq: number }>;
}

export function toVerificationResult(v: VerificationRow, intentId: string): VerificationResult {
  const latest = v.evidence?.length ? [...v.evidence].sort((a, b) => b.seq - a.seq)[0] : undefined;
  return {
    verificationId: v.id,
    orderId: v.orderId,
    intentId,
    mode: fromDbMode(v.mode),
    status: v.status,
    ...(v.verdict ? { verdict: v.verdict } : {}),
    checks: parseChecks(v.checks),
    ...(v.summary
      ? { summary: v.summary }
      : v.error
        ? { summary: `Verification failed: ${v.error}` }
        : {}),
    ...(latest ? { evidenceHash: latest.hash } : {}),
    ...(v.settlement
      ? {
          settlement: {
            action: v.settlement,
            ...(v.paypalStatus ? { paypalStatus: v.paypalStatus } : {}),
          },
        }
      : {}),
  };
}
