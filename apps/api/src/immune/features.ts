// What an antibody is built from and matched against (CONTRACTS-L2 5.2 steps 1 and 5): the text
// the agent read (the chosen listing's page) plus the order's line names and any terms excerpt,
// the 9 structural flags, and the seller's confusables skeleton. Pure functions; the same code
// runs at mint time, at match time and in the promotion gate, so they always agree.
import {
  ANTIBODY_FEATURES,
  type AgentTrace,
  type AntibodyFeature,
  type AttackFamily,
  type Merchant,
  type NormalizedOrder,
} from "@poi/shared";
import { FEE, RECURRING, RENEWED, USED } from "../verifier/deterministic";
import { scoreInjectionHeuristics } from "../verifier/injection";
import { skeleton } from "../verifier/lookalike";
import { orderCents } from "../verifier/normalize";

export type Features = Record<AntibodyFeature, boolean>;

/** The page text of the listing(s) the agent bought, as it read them. */
export function chosenPageText(trace: Pick<AgentTrace, "observedListings" | "chosenSkus">): string {
  return trace.observedListings
    .filter((l) => trace.chosenSkus.includes(l.sku))
    .map((l) => l.pageText)
    .join("\n");
}

export interface OrderEvidence {
  order: NormalizedOrder;
  /** The chosen listing's page text (chosenPageText). */
  pageText: string;
  /** Terms the order is subject to beyond the ingested ones (an arena tenant's excerpt). */
  termsText?: string;
}

/** The text an antibody fingerprints: page text + line names (+ descriptions) + terms excerpt. */
export function evidenceText(e: OrderEvidence): string {
  return [
    e.pageText,
    ...e.order.lines.map((l) => `${l.name} ${l.description ?? ""}`),
    e.termsText ?? "",
  ]
    .join("\n")
    .trim();
}

const RECURRING_TERMS =
  /\brenew\w*|\brecurr\w*|\bper (?:month|year|week)\b|\/\s?(?:mo|month|yr|year)\b|\bmonthly\b|\bsubscri(?:be|ption)\b|\bbilled (?:every|monthly|annually)\b/i;
const TRIAL =
  /\bfree trial\b|\btrial\b|\b(?:#+|\d+)[- ]day (?:free|trial)\b|\bfree for (?:#+|\d+|a|one|two|three) (?:days?|weeks?|months?)\b|\bfirst (?:month|year|week) free\b|\bthen (?:billed|charged|renews?|continues)\b/i;

function primaryLine(order: NormalizedOrder): number {
  const t = orderCents(order).lineTotals;
  return t.reduce((best, x, i) => (x > t[best]! ? i : best), 0);
}

/**
 * The 9 flags. `registry` is the merchant registry: a seller missing from it, or not verified,
 * is unverified.
 */
export function computeFeatures(e: OrderEvidence, registry: Merchant[]): Features {
  const { order } = e;
  const lineTexts = order.lines.map((l) => `${l.name} ${l.description ?? ""}`);
  const all = [e.pageText, ...lineTexts, e.termsText ?? ""].join("\n");
  const c = orderCents(order);
  const primary = primaryLine(order);
  const signals = scoreInjectionHeuristics(e.pageText).signals;
  const merchant = registry.find((m) => m.id === order.merchantId);
  const f: Features = {
    recurrence_in_checkout: lineTexts.some((t) => RECURRING.test(t)),
    recurrence_in_terms: !!e.termsText && RECURRING_TERMS.test(e.termsText),
    trial_language: TRIAL.test(all),
    condition_not_new: lineTexts.some((t) => RENEWED.test(t) || USED.test(t)),
    digital_extra_line: order.lines.some((l, i) => i !== primary && l.category === "DIGITAL_GOODS"),
    fee_lines: c.handling > 0 || c.insurance > 0 || lineTexts.some((t) => FEE.test(t)),
    seller_unverified: !merchant || !merchant.verified,
    addresses_ai: signals.some((s) => /ai agent|addressed to ai|system message/i.test(s)),
    hidden_text_present: signals.some((s) => /invisible characters|hidden-text markers/i.test(s)),
  };
  return f;
}

export const trueFlags = (f: Record<string, boolean>) =>
  ANTIBODY_FEATURES.filter((k) => f[k] === true);

/**
 * Structural match: the antibody's true flags (at least 2) are a subset of the order's. Returns
 * the share of the order's flags the antibody explains (1 when they're identical).
 */
export function featureMatch(antibody: Record<string, boolean>, order: Features): number | null {
  const need = trueFlags(antibody);
  if (need.length < 2 || !need.every((k) => order[k])) return null;
  return need.length / Math.max(need.length, trueFlags(order).length);
}

/**
 * The seller skeleton an antibody keeps: only for an unverified seller (a look-alike candidate).
 * A verified seller's own name is never an attack signature.
 */
export function sellerSkeleton(order: NormalizedOrder, features: Features): string | null {
  if (!features.seller_unverified) return null;
  const s = skeleton(order.merchantDisplayName || order.merchantId);
  return s.length >= 3 ? s : null;
}

/** Families whose antibodies may VOID on structural proof (5.2 step 6). */
export const STRUCTURAL_FAMILIES: ReadonlySet<AttackFamily> = new Set([
  "subscription",
  "addon",
  "lookalike",
  "dripfee",
]);

/**
 * The antibody's strongest action: VOID when its family has structural proof and the antibody
 * carries structural evidence (2+ flags or a seller skeleton); ASK_HUMAN otherwise. At match
 * time a text-only match (MinHash, embedding) is always capped at ASK_HUMAN.
 */
export function antibodyAction(
  family: AttackFamily,
  features: Features,
  skel: string | null,
): "VOID" | "ASK_HUMAN" {
  const structural = trueFlags(features).length >= 2 || skel !== null;
  return STRUCTURAL_FAMILIES.has(family) && structural ? "VOID" : "ASK_HUMAN";
}
