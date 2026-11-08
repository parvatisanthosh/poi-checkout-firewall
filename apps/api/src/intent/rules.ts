// Text evidence used two ways:
//   1. ruleDraft(): a no-LLM compiler (used when COMPILER_MODEL has no key, or the call fails)
//   2. finalize(): guards that reject model output the text doesn't support
// Everything here reads only the user's own words.
import type { Condition, Merchant } from "@poi/shared";
import type { CompilerDraft } from "./draft";

const NUM = String.raw`(\d{1,6}(?:\.\d{1,2})?)`;
const BUDGET_PATTERNS = [
  new RegExp(String.raw`\$\s?${NUM}`, "i"),
  new RegExp(String.raw`${NUM}\s?(?:dollars|bucks|usd)\b`, "i"),
  new RegExp(
    String.raw`\b(?:under|below|less than|max(?:imum)?|up to|at most|no more than|within|budget(?: of| is)?)\s+\$?${NUM}\b`,
    "i",
  ),
];

/** First stated budget amount, normalized to "40.00", or undefined. */
export function statedBudget(text: string): string | undefined {
  for (const re of BUDGET_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1]) return Number(m[1]).toFixed(2);
  }
  return undefined;
}

/** Does `amount` (e.g. "40" or "40.00") appear as a number anywhere in the text? */
export function textMentionsAmount(text: string, amount: string): boolean {
  const want = Number(amount);
  return [...text.matchAll(/\d{1,6}(?:\.\d{1,2})?/g)].some((m) => Number(m[0]) === want);
}

export const EXCLUDES_EXTRAS =
  /\bplus (?:shipping|tax|fees)|\bbefore (?:shipping|tax)|\+\s?(?:shipping|tax)|\bexcluding (?:shipping|tax)|\bnot including (?:shipping|tax)/i;

const WORD_NUMBERS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  ten: 10,
};

/**
 * Only explicit unit counts ("2 of them", "3 units", "x2"). "4 ports" or "100W" are features,
 * not quantities, so a bare number before a noun is deliberately not read as a quantity.
 */
export function statedQuantity(text: string): number | undefined {
  const m =
    /\b(\d{1,3})\s*(?:of (?:them|those|these)|units?\b|pieces\b|pcs\b|x\b)|\bx\s?(\d{1,3})\b/i.exec(
      text,
    );
  const n = m?.[1] ?? m?.[2];
  if (n) return Number(n);
  const word = /\b(two|three|four|five|six|ten) (?:of (?:them|those|these)|units|pieces)\b/i.exec(
    text,
  )?.[1];
  return word ? WORD_NUMBERS[word.toLowerCase()] : undefined;
}

export const MENTIONS_RECURRING =
  /subscri|recurr|monthly|per month|\/mo\b|renew|membership|annual plan|auto-?pay/i;
const RECURRING_OK =
  /(?:subscription|recurring|membership|monthly plan|subscribing)[^.]{0,25}\b(?:ok|okay|fine|allowed|welcome)\b|\b(?:ok|okay|fine) with (?:a )?(?:subscription|recurring)/i;
const ONE_TIME =
  /one[- ]time|no subscriptions?|no recurring|not a subscription|single purchase|one[- ]off/i;

export const MENTIONS_USED_OR_REFURB =
  /refurb|renewed|open[- ]box|\bused\b|pre-?owned|second[- ]hand/i;
const NEW_ONLY = /\bnew only\b|\bonly new\b|brand[- ]new|\bnew condition\b/i;
const REFURB_OK =
  /(?:refurb\w*|renewed|open[- ]box)[^.]{0,20}\b(?:ok|okay|fine|allowed|acceptable)\b|\b(?:ok|okay|fine) with (?:refurb|renewed)/i;
const USED_OK =
  /(?:\bused\b|pre-?owned|second[- ]hand)[^.]{0,20}\b(?:ok|okay|fine|allowed|acceptable)\b/i;

export const MENTIONS_ADDONS =
  /warrant|protection|care\b|care plan|insurance|add-?on|bundle|accessor/i;
const ADDONS_OK =
  /(?:warranty|protection plan|add-?ons?|bundle|accessories)[^.]{0,20}\b(?:ok|okay|fine|allowed|welcome)\b|\bwith (?:a |an )?(?:extended )?warranty\b/i;
const ADDONS_NO = /\bno (?:add-?ons|extras|warrant\w*|protection)/i;

const CATEGORIES: Array<[RegExp, string]> = [
  [/\b(?:usb[- ]?c )?hub\b|\bdock(?:ing station)?\b/i, "usb-c hub"],
  [/\bear ?buds?\b|\bearphones?\b/i, "wireless earbuds"],
  [/\bheadphones?\b/i, "headphones"],
  [/\blaptop (?:stand|riser)\b|\bstand for (?:my |a |the )?laptop\b/i, "laptop stand"],
  [/\bcharger\b/i, "charger"],
  [/\bkeyboard\b/i, "keyboard"],
  [/\bmouse\b/i, "mouse"],
  [/\bmonitor\b/i, "monitor"],
  [/\bwebcam\b/i, "webcam"],
  [/\bcable\b/i, "cable"],
];

function mustHaves(text: string): string[] {
  const out: string[] = [];
  if (/\b4k\b/i.test(text)) out.push(/hdmi/i.test(text) ? "4K HDMI" : "4K");
  const watts = /\b(\d{2,3})\s?w\b/i.exec(text)?.[1];
  if (watts) out.push(`${watts}W power delivery`);
  if (/\banc\b|noise[- ]cancel/i.test(text)) out.push("active noise cancelling");
  if (/alumin/i.test(text)) out.push("aluminium");
  if (/\bethernet\b/i.test(text)) out.push("Ethernet");
  return out;
}

export const normName = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Merchant names mentioned after "from"/"only from" (allowed) or "not from"/"avoid" (blocked). */
export function mentionedMerchants(text: string, registry: Merchant[]) {
  const allowed: string[] = [];
  const blocked: string[] = [];
  const lower = text.toLowerCase();
  for (const m of registry) {
    const name = m.displayName.toLowerCase();
    const at = lower.indexOf(name);
    if (at < 0) continue;
    const before = lower.slice(Math.max(0, at - 16), at);
    if (/(?:not from|avoid|except|never from|no)\s+$/.test(before)) blocked.push(m.displayName);
    else if (/from\s+$/.test(before)) allowed.push(m.displayName);
  }
  return { allowed, blocked };
}

export function ruleDraft(text: string, registry: Merchant[]): CompilerDraft {
  const budget = statedBudget(text);
  const recurrence = RECURRING_OK.test(text)
    ? "recurring-ok"
    : ONE_TIME.test(text)
      ? "one-time"
      : "unstated";
  let conditions: Condition[] | null = null;
  if (USED_OK.test(text)) conditions = ["new", "renewed", "used"];
  else if (REFURB_OK.test(text)) conditions = ["new", "renewed"];
  else if (NEW_ONLY.test(text)) conditions = ["new"];
  const merchants = mentionedMerchants(text, registry);
  return {
    category: CATEGORIES.find(([re]) => re.test(text))?.[1] ?? "",
    mustHave: mustHaves(text),
    niceToHave: [],
    quantity: statedQuantity(text) ?? 1,
    maxTotalUsd: budget ?? null,
    budgetBasis: EXCLUDES_EXTRAS.test(text) ? "excludes-extras" : budget ? "all-in" : "unstated",
    recurrence,
    conditions,
    addOns: ADDONS_OK.test(text) ? "allowed" : ADDONS_NO.test(text) ? "not-allowed" : "unstated",
    allowedMerchantNames: merchants.allowed,
    blockedMerchantNames: merchants.blocked,
    questions: [],
  };
}
