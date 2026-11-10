// Layer 2 pure parts (Q4-Q9): fingerprints, LSH, features and actions, matching, merchant risk,
// conformal risk control, the tighten-only property, counterfactual cost and antibody signatures.
import { describe, expect, it } from "vitest";
import type { Antibody, CheckResult, Merchant, NormalizedOrder, Verdict } from "@poi/shared";
import { seededRandom } from "@poi/shared/arena-fake";
import {
  allowedMisses,
  computeCrc,
  crcCurve,
  gateVerdict,
  NeedMoreData,
  NEVER,
  type CalItem,
} from "../src/calibration/crc";
import { fuse, stageScores } from "../src/calibration/fuse";
import { computeCounterfactual, usdToCents } from "../src/immune/counterfactual";
import { antibodyAction, computeFeatures, featureMatch } from "../src/immune/features";
import {
  estimatedContainment,
  fingerprint,
  minhash,
  murmur3,
  normalizeText,
  shingles,
} from "../src/immune/fingerprint";
import { estimatedJaccard, lshBands } from "../src/immune/lsh";
import { buildProbe, matchAntibody } from "../src/immune/match";
import { familyFromReason } from "../src/immune/mint.job";
import { shouldRetire } from "../src/immune/promote.job";
import { riskCheck, riskScore } from "../src/immune/risk";
import { signAntibody, verifyAntibodySignature } from "../src/immune/sign";
import { decideVerdict, maxVerdict } from "../src/verifier/lattice";
import { testSigningKey } from "./helpers";

const SUB_PAGE =
  "Orbitek UltraHub 8-in-1 USB-C Hub with 4K HDMI and 100W charging. Includes the Orbitek Care " +
  "membership: free for 30 days, then renews at $14.99/mo unless cancelled. Ships from Orbitek " +
  "Direct within two business days. Aluminium shell, braided cable, works with any laptop.";
const OTHER_PAGE =
  "Kordia Air wireless earbuds with active noise cancelling, eight hour battery, a pocket case " +
  "that charges over USB-C, and three sizes of silicone tips. Rated for sweat and light rain.";

const money = (value: string) => ({ currency: "USD", value });
function order(over: Partial<NormalizedOrder> = {}): NormalizedOrder {
  return {
    orderId: "O-1",
    status: "APPROVED",
    intent: "AUTHORIZE",
    merchantId: "orbitek",
    merchantDisplayName: "Orbitek",
    lines: [
      {
        name: "Orbitek UltraHub 8-in-1",
        unitAmount: money("27.99"),
        quantity: 1,
        category: "PHYSICAL_GOODS",
      },
      {
        name: "Orbitek Care membership",
        description: "renews at $6.99/mo",
        unitAmount: money("6.99"),
        quantity: 1,
        category: "DIGITAL_GOODS",
      },
    ],
    breakdown: { itemTotal: money("34.98"), taxTotal: money("2.80") },
    total: money("37.78"),
    ...over,
  };
}
const registry: Merchant[] = [
  { id: "orbitek", displayName: "Orbitek", verified: true },
  { id: "voltra-official", displayName: "Voltra Official", verified: true },
];

describe("fingerprints (Q4)", () => {
  it("murmur3 matches the reference x86_32 values", () => {
    expect(murmur3("")).toBe(0);
    expect(murmur3("hello")).toBe(0x248bfa47);
    expect(murmur3("hello", 1)).toBe(0xbb4abcad);
  });

  it("normalizes NFKC, case, whitespace and digits", () => {
    expect(normalizeText("  Renews at $14.99/MO\n\tnow ")).toBe("renews at $#.#/mo now");
    expect(normalizeText("$9.49/mo")).toBe(normalizeText("$14.99/mo"));
    expect(normalizeText("renews at $##.##/mo")).toBe("renews at $#.#/mo"); // listingText output
    expect(normalizeText("ｆｕｌｌ width")).toBe("full width");
  });

  it("shingles 5-word windows, falling back to 5-char windows for short text", () => {
    expect(shingles("a b c d e f")).toEqual(["a b c d e", "b c d e f"]);
    expect(shingles("great product")).toContain("great");
    expect(shingles("abc")).toEqual(["abc"]);
  });

  it("identical text -> Jaccard 1; a price change only -> still 1; unrelated -> < 0.2", () => {
    const a = fingerprint(SUB_PAGE).minhash;
    expect(estimatedJaccard(a, fingerprint(SUB_PAGE).minhash)).toBe(1);
    const cheaper = SUB_PAGE.replace("$14.99", "$9.49").replace("30 days", "14 days");
    expect(estimatedJaccard(a, fingerprint(cheaper).minhash)).toBe(1);
    expect(estimatedJaccard(a, fingerprint(OTHER_PAGE).minhash)).toBeLessThan(0.2);
  });

  it("signatures are 128 int4-safe numbers and stable", () => {
    const sig = fingerprint(SUB_PAGE).minhash;
    expect(sig).toHaveLength(128);
    expect(sig.every((x) => Number.isInteger(x) && x >= -(2 ** 31) && x < 2 ** 31)).toBe(true);
    expect(fingerprint(SUB_PAGE).minhash).toEqual(sig);
    expect(() => minhash([])).toThrow(/empty/);
  });

  it("LSH: >= 85% of 100 near-duplicate pairs at true Jaccard 0.5 become candidates", () => {
    const rand = seededRandom(42);
    const word = () => Math.floor(rand() * 1e9).toString(36);
    let hits = 0;
    for (let p = 0; p < 100; p++) {
      const base = Array.from({ length: 300 }, word);
      // share 200 of 300: |A n B| = 200, |A u B| = 400 -> J = 0.5
      const other = [...base.slice(0, 200), ...Array.from({ length: 100 }, word)];
      const a = lshBands(minhash(base));
      const b = lshBands(minhash(other));
      if (a.some((h, i) => h === b[i])) hits++;
    }
    expect(hits / 100).toBeGreaterThanOrEqual(0.85);
  });

  it("containment estimate: a short text inside a long one is mostly contained", () => {
    const long = fingerprint(`${SUB_PAGE} ${OTHER_PAGE}`);
    const short = fingerprint(SUB_PAGE);
    const j = estimatedJaccard(short.minhash, long.minhash);
    expect(j).toBeLessThan(0.8);
    expect(estimatedContainment(j, short.shingleCount, long.shingleCount)).toBeGreaterThan(0.8);
  });
});

describe("features, actions and matching (Q4/Q5)", () => {
  it("flags a hidden subscription and acts by family + evidence", () => {
    const f = computeFeatures({ order: order(), pageText: SUB_PAGE }, registry);
    expect(f).toMatchObject({
      recurrence_in_checkout: true,
      trial_language: true,
      digital_extra_line: true,
      seller_unverified: false,
      addresses_ai: false,
    });
    expect(antibodyAction("subscription", f, null)).toBe("VOID");
    expect(antibodyAction("injection", f, null)).toBe("ASK_HUMAN"); // no structural proof family
    const unknownSeller = computeFeatures(
      {
        order: order({ merchantId: "orbitek-0ffical", merchantDisplayName: "0rbitek" }),
        pageText: "x",
      },
      registry,
    );
    expect(unknownSeller.seller_unverified).toBe(true);
  });

  it("feature match needs >= 2 antibody flags, all present in the order", () => {
    const f = computeFeatures({ order: order(), pageText: SUB_PAGE }, registry);
    expect(featureMatch({ recurrence_in_checkout: true }, f)).toBeNull();
    expect(
      featureMatch({ recurrence_in_checkout: true, digital_extra_line: true }, f),
    ).toBeGreaterThan(0);
    expect(featureMatch({ recurrence_in_checkout: true, fee_lines: true }, f)).toBeNull();
  });

  it("text-only matches are capped at ASK_HUMAN; structural ones carry the antibody's action", () => {
    const probe = buildProbe({ order: order(), pageText: SUB_PAGE }, registry);
    const base: Antibody = {
      id: "ab1",
      family: "subscription",
      sourceOrderId: "O-0",
      minhash: probe.minhash,
      features: {},
      skeleton: null,
      action: "VOID",
      status: "active",
      hits: 0,
      falseHits: 0,
      defenderVersion: 1,
      signature: "x",
    };
    const t = { jaccard: 0.5, cosine: 0.85 };
    expect(matchAntibody(base, probe, t)).toMatchObject({
      kind: "minhash",
      action: "ASK_HUMAN",
      similarity: 1,
    });
    const structural = {
      ...base,
      features: { recurrence_in_checkout: true, digital_extra_line: true },
    };
    expect(matchAntibody(structural, probe, t)).toMatchObject({ kind: "features", action: "VOID" });
    const other = buildProbe(
      { order: order({ lines: [order().lines[0]!] }), pageText: OTHER_PAGE },
      registry,
    );
    expect(matchAntibody(structural, other, t)).toBeNull();
    expect(matchAntibody(base, other, t, { cosine: 0.9 })).toMatchObject({
      kind: "embedding",
      action: "ASK_HUMAN",
    });
  });

  it("maps a human's reason (or the order's evidence) to a family", () => {
    const f = computeFeatures({ order: order(), pageText: SUB_PAGE }, registry);
    expect(familyFromReason("it signed me up for a monthly plan", f)).toBe("subscription");
    expect(familyFromReason("the fine print in the terms", f)).toBe("tosrenew");
    expect(familyFromReason("not what I wanted", f)).toBe("subscription"); // from the flags
    const none = computeFeatures(
      { order: order({ lines: [order().lines[0]!] }), pageText: "hub" },
      registry,
    );
    expect(familyFromReason("meh", none)).toBeNull();
  });

  it("auto-retirement: 2+ false hits and false/hits > 0.2", () => {
    expect(shouldRetire({ hits: 3, falseHits: 1 })).toBe(false);
    expect(shouldRetire({ hits: 5, falseHits: 2 })).toBe(true);
    expect(shouldRetire({ hits: 20, falseHits: 2 })).toBe(false);
  });
});

describe("merchant risk (Q7)", () => {
  it("follows the Beta-prior examples from the plan", () => {
    expect(riskScore({ voids: 0, reports: 0, orders: 0 })).toBeCloseTo(0.2);
    expect(riskScore({ voids: 1, reports: 0, orders: 1 })).toBeCloseTo(0.333, 3);
    expect(riskScore({ voids: 1, reports: 1, orders: 2 })).toBeCloseTo(0.4286, 3);
    expect(riskScore({ voids: 2, reports: 1, orders: 20 })).toBeCloseTo(0.16);
  });

  it("asks a human above the threshold, and its score feeds the gate either way", () => {
    const hi = riskCheck({ merchantId: "m", voids: 2, reports: 0, orders: 2, risk: 3 / 7 }, 0.35);
    expect(hi).toMatchObject({ check: "risk", outcome: "fail", severity: "medium" });
    expect(decideVerdict([hi])).toBe("ASK_HUMAN");
    const lo = riskCheck({ merchantId: "m", voids: 0, reports: 0, orders: 0, risk: 0.2 }, 0.35);
    expect(decideVerdict([lo])).toBe("CAPTURE");
    expect(stageScores([lo]).risk).toBeCloseTo(0.2);
  });
});

describe("conformal risk control (Q8)", () => {
  it("the plan's worked example: n = 200, alpha = 0.05 -> 9 misses allowed", () => {
    expect(allowedMisses(200, 0.05)).toBe(9);
    // 80 violating orders scoring 0.01..0.80, 120 benign scoring 0..0.595
    const items: CalItem[] = [
      ...Array.from({ length: 80 }, (_, i) => ({
        s: (i + 1) / 100,
        violating: true,
        family: "subscription" as const,
      })),
      ...Array.from({ length: 120 }, (_, i) => ({ s: i / 200, violating: false })),
    ];
    const r = computeCrc(items, 0.05);
    expect(r.lambdaAsk).toBeCloseTo(0.1); // the 10th lowest violating score
    expect(r.empiricalMiss).toBeCloseTo(9 / 200);
    expect(r.empiricalMiss).toBeLessThanOrEqual(0.05);
    expect(r.lambdaVoid).toBeGreaterThanOrEqual(r.lambdaAsk);
    expect(r.perFamily).toEqual([{ family: "subscription", n: 80, miss: 9 / 80 }]);
    expect(r.benignAskRate).toBeCloseTo(100 / 120); // benign scores >= 0.1
  });

  it("refuses a fake guarantee: NeedMoreData for n = 10 at alpha 0.05", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ s: i / 10, violating: i % 2 === 0 }));
    expect(() => computeCrc(items, 0.05)).toThrow(NeedMoreData);
    expect(computeCrc(items, 0.2).n).toBe(10);
  });

  it("edge cases: no attacks; every attack may be missed", () => {
    const benign = Array.from({ length: 40 }, (_, i) => ({ s: i / 100, violating: false }));
    const r = computeCrc(benign, 0.05);
    expect(r.noAttacks).toBe(true);
    expect(r.lambdaAsk).toBeGreaterThan(0.39);
    expect(r.benignAskRate).toBe(0);
    const fewAttacks = [...benign, { s: 0.5, violating: true }];
    expect(computeCrc(fewAttacks, 0.1).lambdaAsk).toBe(NEVER);
  });

  it("property: lambdaAsk never decreases as alpha grows, and the bound holds in-sample", () => {
    const rand = seededRandom(7);
    for (let trial = 0; trial < 50; trial++) {
      const items = Array.from({ length: 60 + Math.floor(rand() * 200) }, () => ({
        s: rand(),
        violating: rand() < 0.4,
      }));
      let prev = -1;
      for (const point of crcCurve(items)) {
        expect(point.lambdaAsk).toBeGreaterThanOrEqual(prev);
        expect(point.empiricalMiss).toBeLessThanOrEqual(point.alpha);
        prev = point.lambdaAsk;
      }
    }
  });

  it("gate thresholds", () => {
    const c = { lambdaAsk: 0.42, lambdaVoid: 0.88 };
    expect(gateVerdict(0.41, c)).toBe("CAPTURE");
    expect(gateVerdict(0.42, c)).toBe("ASK_HUMAN");
    expect(gateVerdict(0.9, c)).toBe("VOID");
  });
});

describe("tighten-only (Q5/Q8 property)", () => {
  const VERDICTS: Verdict[] = ["CAPTURE", "ASK_HUMAN", "VOID"];
  const RANK = { CAPTURE: 0, ASK_HUMAN: 1, VOID: 2 } as const;
  const OUT = ["pass", "warn", "fail"] as const;
  const SEV = ["low", "medium", "high"] as const;
  const STAGES = ["deterministic", "semantic", "rag", "shadow"] as const;
  it("for 500 random (lattice checks, immune/risk checks, gate) the final verdict is never lower", () => {
    const rand = seededRandom(2026);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    const check = (id: CheckResult["check"], stage: CheckResult["stage"]): CheckResult => ({
      check: id,
      stage,
      outcome: pick(OUT),
      severity: pick(SEV),
      reason: "r",
      confidence: rand(),
      latencyMs: 0,
    });
    for (let i = 0; i < 500; i++) {
      const layer1 = Array.from({ length: Math.floor(rand() * 6) }, () =>
        check("semantic", pick(STAGES)),
      );
      const l1 = decideVerdict(layer1);
      const immune = Array.from({ length: Math.floor(rand() * 3) }, () =>
        check(pick(["immune", "risk"] as const), "semantic"),
      );
      const all = [...layer1, ...immune];
      const final = maxVerdict(decideVerdict(all), pick(VERDICTS));
      expect(RANK[final]).toBeGreaterThanOrEqual(RANK[l1]);
      // and the fused score is monotone: adding stages never lowers s
      expect(fuse(stageScores(all))).toBeGreaterThanOrEqual(fuse(stageScores(layer1)));
    }
  });
});

describe("counterfactual cost (Q9)", () => {
  it("$6.99/month plan + $4.99 add-on = $88.87 over 12 months", () => {
    const o = order({
      lines: [
        order().lines[0]!,
        {
          name: "Care plan",
          description: "$6.99/month",
          unitAmount: money("6.99"),
          quantity: 1,
          category: "DIGITAL_GOODS",
        },
        {
          name: "Protection add-on",
          unitAmount: money("4.99"),
          quantity: 1,
          category: "DIGITAL_GOODS",
        },
      ],
    });
    const c = computeCounterfactual(o);
    expect(c.annualExtraUsd).toBeCloseTo(88.87);
    expect(c.items).toEqual([
      { label: "Care plan", monthlyUsd: 6.99 },
      { label: "Protection add-on", oneOffUsd: 4.99 },
    ]);
  });

  it("an unreadable recurring amount is 'unknown', never guessed; terms renewals count", () => {
    const o = order({
      lines: [{ ...order().lines[0]!, name: "UltraHub with membership" }],
    });
    expect(computeCounterfactual(o).annualExtraUsd).toBeNull();
    const terms = computeCounterfactual(
      order({ lines: [order().lines[0]!] }),
      "Then it automatically renews at $9.49/month unless cancelled.",
    );
    expect(terms).toEqual({
      annualExtraUsd: 113.88,
      items: [{ label: "Renewal in the terms", monthlyUsd: 9.49 }],
    });
    const fees = computeCounterfactual(
      order({
        lines: [order().lines[0]!],
        breakdown: { itemTotal: money("27.99"), handling: money("4.50") },
      }),
    );
    expect(fees.annualExtraUsd).toBe(4.5);
    expect(usdToCents("6.9")).toBe(690);
  });
});

describe("antibody signatures (Q4)", () => {
  it("verifies its own claims and rejects an edited antibody", async () => {
    const key = await testSigningKey();
    const claims = {
      family: "subscription" as const,
      sourceOrderId: "O-1",
      minhash: fingerprint(SUB_PAGE).minhash,
      features: { recurrence_in_checkout: true, digital_extra_line: true },
      skeleton: null,
      action: "VOID" as const,
    };
    const signature = await signAntibody(key, claims);
    const a: Antibody = {
      ...claims,
      id: "a",
      status: "active",
      hits: 3,
      falseHits: 0,
      defenderVersion: 9,
      signature,
    };
    expect(await verifyAntibodySignature(a, key.publicKey)).toBe(true);
    expect(await verifyAntibodySignature({ ...a, action: "ASK_HUMAN" }, key.publicKey)).toBe(false);
    expect(await verifyAntibodySignature(a, (await testSigningKey()).publicKey)).toBe(false);
  });
});
