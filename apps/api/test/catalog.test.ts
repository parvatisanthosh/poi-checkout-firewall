// The Bazaar's real checkout orders vs POI's no-LLM stages (deterministic + terms + injection
// heuristics). Documents exactly what the rules catch on their own and what is left to the
// semantic judge / shadow run -- and proves the honest listings are never blocked.
import { describe, expect, it } from "vitest";
import type { CheckResult, Verdict } from "@poi/shared";
import { buildOrderRequest } from "../../bazaar/src/checkout";
import { loadData } from "../../bazaar/src/data";
import { pageText } from "../../bazaar/src/render-page";
import { compileIntent } from "../src/intent/compiler";
import { PayPalOrder } from "../src/paypal/schemas";
import { runDeterministic } from "../src/verifier/deterministic";
import { scoreInjectionHeuristics } from "../src/verifier/injection";
import { decideVerdict } from "../src/verifier/lattice";
import { normalizeOrder } from "../src/verifier/normalize";
import { chunkTerms, termsChecks } from "../src/verifier/terms-rag";

const bazaar = loadData();
const registry = bazaar.merchants;

async function noLlmVerdict(
  scenarioId: string,
  sku: string,
): Promise<{ verdict: Verdict; checks: CheckResult[] }> {
  const s = bazaar.scenario(scenarioId)!;
  const { draft: spec } = await compileIntent(s.userText, { merchants: registry });
  const { body } = buildOrderRequest(bazaar, [{ sku, qty: 1 }], {
    returnUrl: "http://x",
    cancelUrl: "http://x",
  });
  const order = normalizeOrder(PayPalOrder.parse({ id: `T-${sku}`, status: "APPROVED", ...body }));
  const terms = chunkTerms(bazaar.terms.get(order.merchantId) ?? "").map((text, i) => ({
    id: String(i),
    text,
  }));
  const inj = scoreInjectionHeuristics(pageText(bazaar.product(sku)!, bazaar));
  const checks: CheckResult[] = [
    ...runDeterministic(spec, order, registry),
    ...termsChecks(terms, 0, order, order.merchantDisplayName),
    {
      check: "injection",
      stage: "shadow",
      outcome: inj.confidence >= 0.7 ? "fail" : "pass",
      severity: inj.confidence >= 0.7 ? "medium" : "low",
      reason: inj.signals.join(", "),
      latencyMs: 0,
    },
  ];
  return { verdict: decideVerdict(checks), checks };
}

// What POI decides WITHOUT any LLM. "judge" rows are attacks only the semantic stage can see.
const EXPECTED: Record<string, Verdict> = {
  BEST: "CAPTURE",
  BUDGET: "CAPTURE",
  PREMIUM: "VOID", // over budget once tax is added
  NEARMISS: "CAPTURE", // missing must-have: judge
  "INJ-01": "ASK_HUMAN", // injection heuristics
  "ADDON-01": "VOID",
  "LOOK-01": "VOID",
  "DARK-01": "VOID",
};
const PER_CATEGORY: Record<string, Record<string, Verdict>> = {
  HUB: { "SUB-01": "VOID", "VAR-01": "VOID" },
  EAR: { "SUB-01": "ASK_HUMAN", "VAR-01": "VOID" }, // terms trap; "Grade A"
  STD: { "SUB-01": "ASK_HUMAN", "VAR-01": "CAPTURE" }, // terms trap; "Warehouse Second": judge
};

describe("Bazaar catalog vs POI without an LLM", () => {
  const cases = bazaar.scenarios.flatMap((s) => s.catalog.map((sku) => [s.id, sku] as const));

  it.each(cases)("%s / %s", async (scenarioId, sku) => {
    const [prefix, ...rest] = sku.split("-");
    const key = rest.join("-");
    const expected = PER_CATEGORY[prefix!]?.[key] ?? EXPECTED[key];
    const { verdict, checks } = await noLlmVerdict(scenarioId, sku);
    const why = checks
      .filter((c) => c.outcome !== "pass")
      .map((c) => `${c.check}:${c.outcome}/${c.severity}`);
    expect({ verdict, why }).toMatchObject({ verdict: expected });
  });

  it("every scenario's intent compiles to a signable spec", async () => {
    for (const s of bazaar.scenarios) {
      const { draft, ambiguities } = await compileIntent(s.userText, { merchants: registry });
      expect(Number(draft.maxTotal.value), s.id).toBeGreaterThan(0);
      expect(
        ambiguities.filter((a) => !a.resolvedWith).map((a) => a.field),
        s.id,
      ).toEqual([]);
    }
  });
});
