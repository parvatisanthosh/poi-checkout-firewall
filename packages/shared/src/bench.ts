/**
 * IntentBench-mini result shapes: written by bench/ (runner + summarize), read by the web
 * scorecard. Ground truth comes only from scenario labels, never from POI.
 */
import { z } from "zod";
import { Verdict, VerifierConfig } from "./schemas";

export const BENCH_CONFIGS = {
  deterministic: { deterministic: true, semantic: false, terms: false, shadow: false },
  semantic: { deterministic: true, semantic: true, terms: false, shadow: false },
  terms: { deterministic: true, semantic: true, terms: true, shadow: false },
  full: { deterministic: true, semantic: true, terms: true, shadow: true },
} as const satisfies Record<string, VerifierConfig>;
export type BenchConfigId = keyof typeof BENCH_CONFIGS;
export const BenchConfigId = z.enum(["deterministic", "semantic", "terms", "full"]);

export const BenchFamily = z.enum([
  "injection",
  "subscription",
  "variant",
  "addon",
  "lookalike",
  "darkpattern",
  "benign",
]);
export type BenchFamily = z.infer<typeof BenchFamily>;

/** One line of results/<batchId>.jsonl: one agent run under one verifier config. */
export const BenchRecord = z.object({
  batchId: z.string(),
  runKey: z.string(), // model|scenario|repeat
  model: z.string(),
  scenario: z.string(),
  family: BenchFamily,
  repeat: z.number().int(),
  purchased: z.boolean(),
  chosenSkus: z.array(z.string()),
  /** Oracle: a chosen SKU outside the scenario's acceptableSkus. */
  violation: z.boolean(),
  /** "poison" if the agent bought the scenario's poisoned listing, "mistake" for any other wrong pick. */
  violationKind: z.enum(["none", "poison", "mistake"]),
  config: BenchConfigId.nullable(), // null when there was no purchase to verify
  verdict: Verdict.nullable(),
  verificationId: z.string().nullable(),
  orderId: z.string().nullable(),
  verifyLatencyMs: z.number().nullable(),
  agentMs: z.number(),
  error: z.string().optional(),
  at: z.string(),
});
export type BenchRecord = z.infer<typeof BenchRecord>;

export const Rate = z.object({
  k: z.number().int(),
  n: z.number().int(),
  p: z.number().nullable(),
  lo: z.number().nullable(),
  hi: z.number().nullable(),
});
export type Rate = z.infer<typeof Rate>;

export const BenchRow = z.object({
  model: z.string(), // "all" for totals
  family: BenchFamily.or(z.literal("all-attacks")),
  config: BenchConfigId,
  runs: z.number().int(),
  purchases: z.number().int(),
  /** Attack families: violations / purchases. Benign: wrong picks / purchases. */
  undefendedAsr: Rate,
  /** Violations that POI still CAPTURED / purchases. */
  defendedAsr: Rate,
  askHumanRate: Rate,
  /** Benign only: correct purchases POI voided / correct purchases. */
  falseVoidRate: Rate.nullable(),
  medianVerifyLatencyMs: z.number().nullable(),
});
export type BenchRow = z.infer<typeof BenchRow>;

export const BenchSummary = z.object({
  generatedAt: z.string(),
  batches: z.array(z.string()),
  models: z.array(z.string()),
  rows: z.array(BenchRow),
  /** model "all" rows, for the headline strip. */
  totals: z.array(BenchRow),
  note: z.string(),
});
export type BenchSummary = z.infer<typeof BenchSummary>;

/** Wilson 95% interval for k successes out of n. */
export function wilson(k: number, n: number, z95 = 1.96): Rate {
  if (n === 0) return { k, n, p: null, lo: null, hi: null };
  const p = k / n;
  const d = 1 + (z95 * z95) / n;
  const center = (p + (z95 * z95) / (2 * n)) / d;
  const half = (z95 * Math.sqrt((p * (1 - p)) / n + (z95 * z95) / (4 * n * n))) / d;
  const r = (x: number) => Math.round(x * 10000) / 10000;
  return { k, n, p: r(p), lo: r(Math.max(0, center - half)), hi: r(Math.min(1, center + half)) };
}
