// Conformal Risk Control for the gate (CONTRACTS-L2 5.4). Pure.
// Loss = "violating and captured", bounded by 1. With n calibration orders and level alpha:
//   allowed misses m = floor(alpha (n + 1) - 1); m < 0 -> NeedMoreData (no fake guarantee)
//   lambdaAsk = the (m + 1)-th lowest violating score  (capture only when s < lambdaAsk)
//   lambdaVoid = max(lambdaAsk, benign quantile q)     (VOID when s >= lambdaVoid)
// Worked example: n = 200, alpha = 0.05 -> m = floor(9.05) = 9, lambdaAsk = 10th lowest violating.
import type { AttackFamily, CalibrationCurvePoint, CalibrationResult } from "@poi/shared";

export interface CalItem {
  /** Fused score s in [0, 1]. */
  s: number;
  /** Oracle label: the agent bought the poisoned listing. */
  violating: boolean;
  family?: AttackFamily;
}

export class NeedMoreData extends Error {
  constructor(
    readonly n: number,
    readonly alpha: number,
  ) {
    super(
      `Need more calibration data: ${n} orders can't support alpha = ${alpha} ` +
        `(needs at least ${Math.ceil(1 / alpha - 1)}).`,
    );
  }
}

/** A threshold above every possible score: "never". Scores live in [0, 1]. */
export const NEVER = 1.000001;

export type CrcResult = Omit<CalibrationResult, "id" | "createdAt"> & {
  /** True when the set has no violating orders (lambdaAsk then sits just above every benign score). */
  noAttacks: boolean;
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Nearest-rank quantile of a non-empty ascending array. */
export function quantile(sorted: number[], q: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

export function allowedMisses(n: number, alpha: number): number {
  // The epsilon absorbs float error in alpha * (n + 1) (e.g. 0.05 * 20 - 1 = 0 must not be -1e-17).
  return Math.floor(alpha * (n + 1) - 1 + 1e-9);
}

export function computeCrc(items: CalItem[], alpha: number, benignVoidQuantile = 0.99): CrcResult {
  const n = items.length;
  const m = allowedMisses(n, alpha);
  if (m < 0) throw new NeedMoreData(n, alpha);

  const viol = items
    .filter((i) => i.violating)
    .map((i) => clamp01(i.s))
    .sort((a, b) => a - b);
  const benign = items
    .filter((i) => !i.violating)
    .map((i) => clamp01(i.s))
    .sort((a, b) => a - b);

  let lambdaAsk: number;
  if (viol.length === 0) lambdaAsk = benign.length ? Math.min(NEVER, benign.at(-1)! + 1e-6) : NEVER;
  else if (m >= viol.length)
    lambdaAsk = NEVER; // every attack may be missed within the bound
  else lambdaAsk = viol[m]!;

  const lambdaVoid = Math.max(
    lambdaAsk,
    benign.length ? quantile(benign, benignVoidQuantile) : NEVER,
  );

  const missed = (s: number) => s < lambdaAsk;
  const families = new Map<AttackFamily, { n: number; miss: number }>();
  for (const it of items) {
    if (!it.violating || !it.family) continue;
    const f = families.get(it.family) ?? { n: 0, miss: 0 };
    f.n++;
    if (missed(clamp01(it.s))) f.miss++;
    families.set(it.family, f);
  }
  const rate = (k: number, of: number) => (of ? k / of : 0);
  return {
    alpha,
    n,
    nViolating: viol.length,
    lambdaAsk,
    lambdaVoid,
    empiricalMiss: rate(viol.filter(missed).length, n),
    benignAskRate: rate(benign.filter((s) => s >= lambdaAsk).length, benign.length),
    benignVoidRate: rate(benign.filter((s) => s >= lambdaVoid).length, benign.length),
    perFamily: [...families.entries()]
      .map(([family, f]) => ({ family, n: f.n, miss: rate(f.miss, f.n) }))
      .sort((a, b) => a.family.localeCompare(b.family)),
    noAttacks: viol.length === 0,
  };
}

export const CURVE_ALPHAS = Array.from({ length: 20 }, (_, i) => (i + 1) / 100);

/** The miss / benign-friction trade-off for alpha 0.01..0.20 (alphas the data can't support are left out). */
export function crcCurve(items: CalItem[], benignVoidQuantile = 0.99): CalibrationCurvePoint[] {
  return CURVE_ALPHAS.flatMap((alpha) => {
    try {
      const r = computeCrc(items, alpha, benignVoidQuantile);
      return [
        {
          alpha,
          lambdaAsk: r.lambdaAsk,
          empiricalMiss: r.empiricalMiss,
          benignAskRate: r.benignAskRate,
        },
      ];
    } catch (err) {
      if (err instanceof NeedMoreData) return [];
      throw err;
    }
  });
}

/** The gate's verdict for a fused score: VOID >= lambdaVoid > ASK_HUMAN >= lambdaAsk > CAPTURE. */
export function gateVerdict(
  s: number,
  c: { lambdaAsk: number; lambdaVoid: number },
): "CAPTURE" | "ASK_HUMAN" | "VOID" {
  if (s >= c.lambdaVoid) return "VOID";
  if (s >= c.lambdaAsk) return "ASK_HUMAN";
  return "CAPTURE";
}
