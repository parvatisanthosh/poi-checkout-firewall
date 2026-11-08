// P5: the semantic judge. Catches what regex can't (paraphrased subscriptions, "Like-New
// certified", bundled coverage, wrong category, missing must-haves) without becoming injectable:
//   - it sees ONLY the signed IntentSpec (trusted) and the normalized order + retrieved terms
//     (untrusted, spotlighted). Never the agent's reasoning or raw product pages.
//   - its findings are post-processed: unknown fields are dropped, the stage is forced to
//     "semantic", and per the lattice a judge "pass" can never lower a verdict.
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import {
  formatMoney,
  type CheckResult,
  type IntentSpec,
  type Merchant,
  type NormalizedOrder,
} from "@poi/shared";
import { createSpotlighter, resolvePointer } from "./spotlight";

/** Check ids the judge may report. Amount/currency/merchant are deterministic-only. */
export const JUDGE_CHECKS = [
  "recurrence",
  "condition",
  "addons",
  "category",
  "semantic",
  "terms",
] as const;

const Finding = z.object({
  check: z.enum(JUDGE_CHECKS),
  outcome: z.enum(["warn", "fail"]),
  severity: z.enum(["low", "medium", "high"]),
  field: z
    .string()
    .describe('JSON pointer into the order, e.g. "/lines/1/description" or "/lines/0/name".'),
  reason: z.string().describe("One plain-English sentence for the shopper."),
  confidence: z.number().min(0).max(1),
});
export const JudgeOutput = z.object({ findings: z.array(Finding) });
export type JudgeOutput = z.infer<typeof JudgeOutput>;

export interface TermsChunkInput {
  id: string;
  text: string;
}

export interface JudgeOptions {
  model?: LanguageModel;
  registry?: Merchant[];
  terms?: TermsChunkInput[];
  timeoutMs?: number;
}

function buildPrompt(
  spec: IntentSpec,
  order: NormalizedOrder,
  registry: Merchant[],
  terms: TermsChunkInput[],
) {
  const s = createSpotlighter();
  const verified = registry.find((m) => m.id === order.merchantId)?.verified ?? false;
  const b = order.breakdown;
  const lines = order.lines
    .map((l, i) =>
      [
        `[${i}] quantity ${l.quantity}, unit price ${formatMoney(l.unitAmount)}${l.category ? `, PayPal category ${l.category}` : ""}`,
        `    name (/lines/${i}/name): ${s.wrap(l.name)}`,
        ...(l.description
          ? [`    description (/lines/${i}/description): ${s.wrap(l.description)}`]
          : []),
        ...(l.sku ? [`    sku (/lines/${i}/sku): ${s.wrap(l.sku)}`] : []),
      ].join("\n"),
    )
    .join("\n");
  const termsBlock = terms.length
    ? `\n\nMERCHANT TERMS (retrieved excerpts; cite field "/terms/<n>"):\n${terms.map((t, i) => `[${i}] ${s.wrap(t.text)}`).join("\n")}`
    : "";

  const system = `You are the semantic checker in a payment firewall. A shopping agent placed an order on the
user's behalf. Decide whether the order matches what the user signed. You do not approve or reject;
you report problems, and other stages make the decision.

${s.rule}

Report a finding for each problem you see:
- recurrence: any recurring charge in any phrasing (e.g. "billed every 30 days", "renews", "membership",
  "trial then $x") when the user wants a one-time purchase.
- condition: any item that is not new (refurbished, renewed, "like-new certified", open-box, used, grade
  A/B) when it is not in the user's allowed conditions.
- addons: anything bundled or added beyond the requested item (warranties, coverage, protection, care
  plans, accessories, fees) when add-ons are not allowed -- including when it is folded into the main
  item's name or description.
- category: the item is not the kind of product the user asked for.
- semantic: a must-have feature that the order clearly does not provide, or anything else that
  contradicts the user's intent.
- terms: a retrieved terms excerpt that adds a recurring charge, fee or condition the user did not accept
  AND applies to what was ordered.
Use outcome "fail" when you are confident it violates the intent, "warn" when it is uncertain.
severity: "high" for recurring charges, wrong condition, wrong category or unrequested paid add-ons;
"medium" for a missing must-have or unclear risk; "low" for minor doubts.
Every finding needs "field": the JSON pointer printed next to the text you are citing.
If the order matches the intent, return an empty findings list. Do not invent problems.`;

  const prompt = `USER INTENT (trusted, signed by the user):
${JSON.stringify(
  {
    category: spec.category,
    mustHave: spec.mustHave,
    niceToHave: spec.niceToHave,
    quantity: spec.quantity,
    maxTotalAllIn: formatMoney(spec.maxTotal),
    oneTimeOnly: spec.oneTimeOnly,
    allowedConditions: spec.allowedConditions,
    allowAddOns: spec.allowAddOns,
  },
  null,
  2,
)}

ORDER (amounts are PayPal's, trusted; text fields are merchant-written):
merchant id: ${order.merchantId} (${verified ? "verified" : "NOT verified"} in POI's registry)
merchant name (/merchantDisplayName): ${s.wrap(order.merchantDisplayName)}
total ${formatMoney(order.total)} = items ${formatMoney(b.itemTotal)}${b.shipping ? ` + shipping ${formatMoney(b.shipping)}` : ""}${b.handling ? ` + handling ${formatMoney(b.handling)}` : ""}${b.taxTotal ? ` + tax ${formatMoney(b.taxTotal)}` : ""}${b.insurance ? ` + insurance ${formatMoney(b.insurance)}` : ""}${b.discount ? ` - discount ${formatMoney(b.discount)}` : ""}
lines:
${lines}${termsBlock}`;
  return { system, prompt, nonce: s.nonce };
}

/**
 * Keep only findings that point at something real, force stage "semantic", clamp confidence.
 * A low-confidence "fail" (< 0.5) is recorded as a "warn": it is the judge's own hedge, and
 * deterministic results are unaffected either way.
 */
export function postProcess(
  out: JudgeOutput,
  order: NormalizedOrder,
  terms: TermsChunkInput[],
  latencyMs: number,
): CheckResult[] {
  const view = { ...order, terms: terms.map((t) => t.text) };
  const results: CheckResult[] = [];
  for (const f of out.findings) {
    if (!f.field || resolvePointer(view, f.field) === undefined) continue;
    const confidence = Math.min(1, Math.max(0, f.confidence));
    results.push({
      check: f.check,
      stage: "semantic",
      outcome: f.outcome === "fail" && confidence < 0.5 ? "warn" : f.outcome,
      severity: f.severity,
      field: f.field,
      reason: f.reason.slice(0, 300),
      confidence,
      latencyMs,
    });
  }
  return results.length
    ? results
    : [
        {
          check: "semantic",
          stage: "semantic",
          outcome: "pass",
          severity: "low",
          reason: "The semantic check found nothing that contradicts your intent.",
          latencyMs,
        },
      ];
}

export async function judgeOrder(
  spec: IntentSpec,
  order: NormalizedOrder,
  opts: JudgeOptions,
): Promise<CheckResult[]> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  if (!opts.model) {
    return [
      {
        check: "semantic",
        stage: "semantic",
        outcome: "warn",
        severity: "low",
        reason: "The semantic judge is not configured (no JUDGE_MODEL key); only rule checks ran.",
        latencyMs: 0,
      },
    ];
  }
  const terms = opts.terms ?? [];
  const { system, prompt } = buildPrompt(spec, order, opts.registry ?? [], terms);
  try {
    const { output } = await generateText({
      model: opts.model,
      system,
      prompt,
      output: Output.object({ schema: JudgeOutput, name: "findings" }),
      temperature: 0,
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    return postProcess(JudgeOutput.parse(output), order, terms, ms());
  } catch (err) {
    // Configured but failed: don't let money move on rules alone without a person looking.
    return [
      {
        check: "semantic",
        stage: "semantic",
        outcome: "warn",
        severity: "high",
        reason: `The semantic judge failed (${(err as Error).name}), so a person should confirm this order.`,
        latencyMs: ms(),
      },
    ];
  }
}

export { buildPrompt as buildJudgePrompt };
