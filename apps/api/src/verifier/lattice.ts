// The verdict rule, exactly as docs/CONTRACTS.md 2.2. Pure functions.
import type { CheckResult, Verdict } from "@poi/shared";

const RANK: Record<Verdict, number> = { CAPTURE: 0, ASK_HUMAN: 1, VOID: 2 };

/** CAPTURE < ASK_HUMAN < VOID. */
export function maxVerdict(...vs: Verdict[]): Verdict {
  return vs.reduce<Verdict>((a, b) => (RANK[b] > RANK[a] ? b : a), "CAPTURE");
}

/** What a single check contributes to the verdict. */
export function verdictOf(c: CheckResult): Verdict {
  if (c.outcome === "fail" && c.stage === "deterministic") return "VOID";
  if (c.outcome === "fail" && c.severity === "high") return "VOID";
  if (c.outcome === "fail" && c.severity === "medium") return "ASK_HUMAN";
  if (c.outcome === "warn" && c.severity === "high") return "ASK_HUMAN";
  // A shadow "signal" = a fail, or a warn above low. Low warns are "inconclusive" (timeout, no key)
  // and must never block a purchase on their own.
  if (
    c.stage === "shadow" &&
    (c.outcome === "fail" || (c.outcome === "warn" && c.severity !== "low"))
  )
    return "ASK_HUMAN";
  return "CAPTURE";
}

/**
 * Final verdict = max over all checks. Because it is a max, adding an LLM stage's results can
 * only raise it: a semantic "pass" contributes CAPTURE, which never lowers a VOID.
 */
export function decideVerdict(checks: CheckResult[]): Verdict {
  return maxVerdict(...checks.map(verdictOf));
}

const SEVERITY_RANK = { low: 0, medium: 1, high: 2 } as const;
const OUTCOME_RANK = { pass: 0, warn: 1, fail: 2 } as const;

/** The check that most explains the verdict (for summaries and the ledger's topReason). */
export function topCheck(checks: CheckResult[]): CheckResult | undefined {
  return [...checks]
    .filter((c) => c.outcome !== "pass")
    .sort(
      (a, b) =>
        RANK[verdictOf(b)] - RANK[verdictOf(a)] ||
        OUTCOME_RANK[b.outcome] - OUTCOME_RANK[a.outcome] ||
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
    )[0];
}
