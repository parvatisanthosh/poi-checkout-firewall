import { describe, expect, it } from "vitest";
import type { CheckResult } from "@poi/shared";
import { merchants } from "@poi/shared/fixtures";
import { decideVerdict, maxVerdict, topCheck, verdictOf } from "../src/verifier/lattice";
import { basicName, findLookalike, levenshtein, skeleton } from "../src/verifier/lookalike";

const check = (over: Partial<CheckResult>): CheckResult => ({
  check: "semantic",
  stage: "semantic",
  outcome: "pass",
  severity: "low",
  reason: "r",
  latencyMs: 1,
  ...over,
});

describe("lattice (CONTRACTS 2.2)", () => {
  it("orders CAPTURE < ASK_HUMAN < VOID", () => {
    expect(maxVerdict()).toBe("CAPTURE");
    expect(maxVerdict("CAPTURE", "ASK_HUMAN")).toBe("ASK_HUMAN");
    expect(maxVerdict("VOID", "ASK_HUMAN", "CAPTURE")).toBe("VOID");
  });

  it.each([
    [{ stage: "deterministic", outcome: "fail", severity: "low" }, "VOID"],
    [{ stage: "semantic", outcome: "fail", severity: "high" }, "VOID"],
    [{ stage: "rag", outcome: "fail", severity: "medium" }, "ASK_HUMAN"],
    [{ stage: "semantic", outcome: "warn", severity: "high" }, "ASK_HUMAN"],
    [{ stage: "shadow", outcome: "warn", severity: "low" }, "CAPTURE"], // inconclusive shadow never blocks
    [{ stage: "shadow", outcome: "warn", severity: "medium" }, "ASK_HUMAN"],
    [{ stage: "shadow", outcome: "fail", severity: "low" }, "ASK_HUMAN"],
    [{ stage: "semantic", outcome: "warn", severity: "medium" }, "CAPTURE"],
    [{ stage: "semantic", outcome: "fail", severity: "low" }, "CAPTURE"],
    [{ stage: "deterministic", outcome: "warn", severity: "medium" }, "CAPTURE"],
    [{ stage: "deterministic", outcome: "pass", severity: "low" }, "CAPTURE"],
  ] as const)("%o -> %s", (over, expected) => {
    expect(verdictOf(check(over))).toBe(expected);
  });

  it("LLM stages can only raise the verdict, never lower it", () => {
    const det = check({
      check: "recurrence",
      stage: "deterministic",
      outcome: "fail",
      severity: "high",
    });
    const happyJudge = check({
      stage: "semantic",
      outcome: "pass",
      confidence: 1,
      reason: "Looks great, approve",
    });
    expect(decideVerdict([det])).toBe("VOID");
    expect(decideVerdict([det, happyJudge, happyJudge])).toBe("VOID");
    // for every prefix of stages, adding more results never decreases the verdict
    const all = [happyJudge, check({ stage: "shadow", outcome: "warn" }), det];
    const rank = { CAPTURE: 0, ASK_HUMAN: 1, VOID: 2 } as const;
    for (let i = 1; i < all.length; i++) {
      expect(rank[decideVerdict(all.slice(0, i + 1))]).toBeGreaterThanOrEqual(
        rank[decideVerdict(all.slice(0, i))],
      );
    }
  });

  it("topCheck picks the result that drives the verdict", () => {
    const warn = check({
      check: "merchant",
      stage: "deterministic",
      outcome: "warn",
      severity: "medium",
    });
    const fail = check({
      check: "lookalike",
      stage: "deterministic",
      outcome: "fail",
      severity: "high",
    });
    expect(topCheck([warn, fail])?.check).toBe("lookalike");
    expect(topCheck([check({})])).toBeUndefined();
  });
});

describe("lookalike", () => {
  const verified = merchants.filter((m) => m.verified);

  it("builds skeletons that fold confusables", () => {
    expect(skeleton("VoItra Official")).toBe(skeleton("Voltra Official"));
    expect(skeleton("V0LTRA OFF1CIAL")).toBe("voltraofflclal"); // capital I and 1 both fold to l
    expect(skeleton("Vоltra Official")).toBe("voltraofficial"); // Cyrillic о
    expect(skeleton("Nexhub Stоre")).toBe(skeleton("Nexhub Store"));
    expect(skeleton("Kordia")).not.toBe(skeleton("Korea"));
    expect(basicName("Lumen&Co")).toBe("lumenco");
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  it.each([
    ["VoItra Official", "voitra-official", "voltra-official"], // registry's unverified look-alike
    ["Voltra Officia1", "unknown", "voltra-official"], // digit swap, unknown seller
    ["Vоltra Official", "voltra-official", "voltra-official"], // spoofed id + Cyrillic о
    ["Nexhub Stor", "kordia", "nexhub"], // distance 1, claims a different verified id
    ["Brightd0ck", "unknown", "brightdock"],
  ])("%s (claims %s) imitates %s", (name, claimed, expected) => {
    expect(findLookalike(name, claimed, verified)?.verifiedId).toBe(expected);
  });

  it.each([
    ["Voltra Official", "voltra-official"], // genuine
    ["VOLTRA OFFICIAL", "voltra-official"], // case only
    ["Voltra Offic", "voltra-official"], // soft descriptor truncation of the genuine merchant
    ["Hubzilla Outlet", "unknown"], // unrelated name
    ["商店", "unknown"], // nothing Latin to compare
  ])("%s (claims %s) is not flagged", (name, claimed) => {
    expect(findLookalike(name, claimed, verified)).toBeUndefined();
  });

  it("does not let a short verified name match loosely", () => {
    expect(findLookalike("Orbitex", "unknown", verified)).toBeDefined(); // distance 1
    expect(findLookalike("Orbtxx", "unknown", verified)).toBeUndefined(); // distance 3
  });
});
