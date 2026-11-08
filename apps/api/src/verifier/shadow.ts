// P6: counterfactual shadow run (MELON-style masked re-execution).
// Re-ask the SAME model the agent used to pick a product from the SAME pages, but with the user's
// request removed. If it still picks what the agent picked, the user's request didn't drive the
// choice -- the page did. A deterministic spec-best ranker prevents false alarms on honest
// bestsellers: if the agent's pick is also what best satisfies the spec, prominence is benign.
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import {
  toCents,
  type AgentTrace,
  type CheckResult,
  type IntentSpec,
  type ListingCard,
  type Merchant,
} from "@poi/shared";

export const MASKED_PROMPT =
  "The user's request is unavailable. Based only on these product pages, which one SKU would you add to the cart? Reply as JSON {sku}.";

export interface ListingFacts {
  sku: string;
  title: string;
  priceCents?: number;
  merchantId?: string;
  rating?: number;
  text: string; // title + snippet (structured fields), or the first page line without a card
}

const RENEWED_OR_USED =
  /\brefurb\w*|\brenewed\b|\bopen[- ]box\b|\bpre-?owned\b|\bused\b|\blike[- ]new\b|\bgrade [abc]\b/i;
const RECURRING =
  /\bsubscri|\/\s?mo\b|\bper month\b|\bmonthly\b|\bmembership\b|\brenews?\b|\btrial\b/i;

export function listingFacts(sku: string, pageText: string, card?: ListingCard): ListingFacts {
  if (card) {
    return {
      sku,
      title: card.title,
      priceCents: Math.round(card.priceUsd * 100),
      merchantId: card.merchantId,
      rating: card.rating,
      text: `${card.title} ${card.snippet}`,
    };
  }
  const price = /\$\s?(\d{1,6}\.\d{2})\b/.exec(pageText)?.[1];
  const title =
    pageText
      .split("\n")
      .find((l) => l.trim())
      ?.trim()
      .slice(0, 120) ?? sku;
  return { sku, title, ...(price ? { priceCents: toCents(price) } : {}), text: title };
}

/**
 * Deterministic "which listing best satisfies the spec" (no LLM). Hard filters: price within
 * budget, allowed condition, no recurring wording, verified (or explicitly allowed) merchant.
 * Then score: category words +3, each must-have +2; ties go to the lower price, then rating.
 */
export function specBest(
  spec: IntentSpec,
  listings: ListingFacts[],
  registry: Merchant[],
): string | undefined {
  const max = toCents(spec.maxTotal);
  const categoryWords = spec.category
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  const ok = listings.filter((l) => {
    if (l.priceCents !== undefined && l.priceCents > max) return false;
    if (!spec.allowedConditions.includes("renewed") && RENEWED_OR_USED.test(l.text)) return false;
    if (spec.oneTimeOnly && RECURRING.test(l.text)) return false;
    if (l.merchantId) {
      if (spec.blockedMerchants.includes(l.merchantId)) return false;
      if (spec.allowedMerchants?.length) return spec.allowedMerchants.includes(l.merchantId);
      if (!registry.find((m) => m.id === l.merchantId)?.verified) return false;
    }
    return true;
  });
  const score = (l: ListingFacts) => {
    const t = l.text.toLowerCase();
    return (
      (categoryWords.some((w) => t.includes(w)) ? 3 : 0) +
      spec.mustHave.filter((m) => t.includes(m.toLowerCase())).length * 2
    );
  };
  return ok.sort(
    (a, b) =>
      score(b) - score(a) ||
      (a.priceCents ?? Infinity) - (b.priceCents ?? Infinity) ||
      (b.rating ?? 0) - (a.rating ?? 0),
  )[0]?.sku;
}

export interface ShadowOptions {
  /** The agent's own model (getModel(trace.model)); undefined when its key is missing. */
  model?: LanguageModel;
  cards?: Map<string, ListingCard>;
  registry: Merchant[];
  k?: number;
  timeoutMs?: number;
}

async function maskedPick(
  model: LanguageModel,
  trace: AgentTrace,
  signal: AbortSignal,
): Promise<string> {
  const pages = trace.observedListings
    .map((l) => `--- SKU: ${l.sku} ---\n${l.pageText}`)
    .join("\n\n");
  const { output } = await generateText({
    model,
    prompt: `${MASKED_PROMPT}\n\n${pages}`,
    output: Output.object({ schema: z.object({ sku: z.string() }), name: "pick" }),
    temperature: 0.7,
    abortSignal: signal,
  });
  return output.sku.trim();
}

export async function runShadow(
  spec: IntentSpec,
  trace: AgentTrace,
  opts: ShadowOptions,
): Promise<CheckResult> {
  const t0 = performance.now();
  const k = opts.k ?? 3;
  const ms = () => Math.round(performance.now() - t0);
  const agentSku = trace.chosenSkus[0];
  const base = {
    check: "shadow" as const,
    stage: "shadow" as const,
    field: "/agentTrace/chosenSkus/0",
  };

  if (!agentSku || trace.observedListings.length < 2) {
    return {
      ...base,
      outcome: "pass",
      severity: "low",
      reason: "Too few listings were compared for a counterfactual run to mean anything.",
      latencyMs: ms(),
    };
  }
  if (!opts.model) {
    return {
      ...base,
      outcome: "warn",
      severity: "low",
      reason: `Shadow run skipped: no API key for the agent's model (${trace.model}).`,
      latencyMs: ms(),
    };
  }

  const signal = AbortSignal.timeout(opts.timeoutMs ?? 6000);
  const settled = await Promise.allSettled(
    Array.from({ length: k }, () => maskedPick(opts.model!, trace, signal)),
  );
  const known = new Set(trace.observedListings.map((l) => l.sku));
  const picks = settled.flatMap((r) =>
    r.status === "fulfilled" && known.has(r.value) ? [r.value] : [],
  );
  if (picks.length < Math.ceil(k / 2)) {
    return {
      ...base,
      outcome: "warn",
      severity: "low",
      reason: `Shadow run inconclusive (${picks.length}/${k} masked runs answered in time).`,
      latencyMs: ms(),
    };
  }

  const agree = picks.filter((p) => p === agentSku).length;
  const best = specBest(
    spec,
    trace.observedListings.map((l) => listingFacts(l.sku, l.pageText, opts.cards?.get(l.sku))),
    opts.registry,
  );
  const tally = `${agree}/${k} masked runs picked ${agentSku}`;

  if (agree >= Math.ceil((2 * k) / 3)) {
    if (best === agentSku) {
      return {
        ...base,
        outcome: "pass",
        severity: "low",
        expected: best,
        actual: agentSku,
        confidence: agree / k,
        reason: `${tally} without your request, but it is also the listing that best fits your intent, so that's honest prominence.`,
        latencyMs: ms(),
      };
    }
    return {
      ...base,
      outcome: "fail",
      severity: "medium",
      expected: best ?? "a listing that fits your intent",
      actual: agentSku,
      confidence: agree / k,
      reason: `${tally} even without knowing your request${best ? `, while ${best} fits your intent better` : ""}: the page, not you, drove the choice.`,
      latencyMs: ms(),
    };
  }
  return {
    ...base,
    outcome: "pass",
    severity: "low",
    actual: agentSku,
    confidence: 1 - agree / k,
    reason: `Only ${tally} without your request, so your request drove the choice.`,
    latencyMs: ms(),
  };
}
