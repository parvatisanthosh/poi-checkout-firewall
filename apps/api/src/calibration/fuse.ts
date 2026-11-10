// Stage scores (CONTRACTS-L2 5.4 step 1). Each probabilistic check maps to [0, 1]:
//   fail = its confidence (0.9 if missing), warn = half its confidence, pass = 0.
// A stage's score is the max over its checks; the fused score s = max over stages. The max keeps
// the gate monotone (adding a stage can only raise s) and explainable ("the shadow run drove this").
// Deterministic checks are not scored: an order with a deterministic fail is VOIDed before the
// gate and excluded from calibration.
import type { CheckResult, StageScores } from "@poi/shared";

const MISSING_CONFIDENCE = 0.9;

export function checkScore(c: CheckResult): number {
  // Merchant risk is itself a probability estimate: its score is the risk, pass or fail.
  if (c.check === "risk") return c.confidence ?? 0;
  const confidence = c.confidence ?? MISSING_CONFIDENCE;
  if (c.outcome === "fail") return confidence;
  if (c.outcome === "warn") return confidence / 2;
  return 0;
}

/** Which StageScores key a check feeds, or null for deterministic checks. */
export function stageKey(c: CheckResult): keyof StageScores | null {
  if (c.check === "immune") return "immune";
  if (c.check === "risk") return "risk";
  if (c.check === "injection") return "injection";
  if (c.check === "shadow" || c.stage === "shadow") return "shadow";
  if (c.stage === "rag") return "terms";
  if (c.stage === "semantic") return "semantic";
  return null;
}

export function stageScores(checks: CheckResult[]): StageScores {
  const s: StageScores = { semantic: 0, terms: 0, shadow: 0, injection: 0, immune: 0, risk: 0 };
  for (const c of checks) {
    const key = stageKey(c);
    if (key) s[key] = Math.max(s[key], Math.min(1, Math.max(0, checkScore(c))));
  }
  return s;
}

/** s = max(semantic, terms, shadow, injection, immune, risk). */
export function fuse(s: StageScores): number {
  return Math.max(s.semantic, s.terms, s.shadow, s.injection, s.immune, s.risk);
}

/** True when any deterministic check failed (such orders never reach the gate). */
export const hasDeterministicFail = (checks: CheckResult[]) =>
  checks.some((c) => c.stage === "deterministic" && c.outcome === "fail");
