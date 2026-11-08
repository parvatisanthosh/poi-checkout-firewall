// The deterministic stage: rules over integer cents and fixed patterns. It never calls a model
// and never follows anything written in the order, so no merchant text can talk it out of a
// result. Any `fail` here is a VOID (lattice.ts).
import {
  fromCents,
  toCents,
  type CheckId,
  type CheckResult,
  type IntentSpec,
  type Merchant,
  type NormalizedOrder,
} from "@poi/shared";
import { findLookalike } from "./lookalike";
import { orderCents, UNKNOWN_MERCHANT } from "./normalize";

type Partial = Omit<CheckResult, "stage" | "latencyMs">;

// --- patterns over merchant-written line text (names + descriptions)
export const RECURRING =
  /\bper (?:month|year|week)\b|\/\s?(?:mo|month|yr|year|wk)\b|\b(?:monthly|yearly|annually|weekly)\b|\bsubscri(?:be|ption)\b|\brenews?\b|\bauto-?renew\w*|\bannual plan\b|\bmembership\b|\btrial,? then\b|\bfree trial\b|\brecurring\b|\bbilled every\b/i;
const RENEWED =
  /\brefurb\w*|\brenewed\b|\breconditioned\b|\brecertified\b|\bopen[- ]box\b|\bgrade [abc]\b|\blike[- ]new\b/i;
const USED =
  /\bpre-?owned\b|\bsecond[- ]hand\b|\(used\)|\bused[- ](?:condition|item|unit|grade)\b|\bcondition:\s*used\b/i;
const PROTECTION =
  /\bwarrant(?:y|ies)\b|\bprotection(?: plan| pack)?\b|\bcare\s?(?:\+|plus|plan|pack)|\binsurance\b|\bguarantee plan\b|\bcoverage\b/i;
const FEE = /\bfee\b|\bsurcharge\b|\bservice charge\b|\bconvenience\b|\bprocessing\b/i;

const lineText = (l: NormalizedOrder["lines"][number]) => `${l.name} ${l.description ?? ""}`;
const quote = (s: string) => `"${s.length > 60 ? `${s.slice(0, 59)}…` : s}"`;
const usd = (cents: number, currency: string) => `$${fromCents(cents, currency).value}`;

function primaryLineIndex(order: NormalizedOrder): number {
  const totals = orderCents(order).lineTotals;
  return totals.reduce((best, t, i) => (t > totals[best]! ? i : best), 0);
}

function amount(spec: IntentSpec, order: NormalizedOrder): Partial[] {
  const out: Partial[] = [];
  const c = orderCents(order);
  const cur = order.total.currency;
  const max = toCents(spec.maxTotal);

  if (c.linesSum !== c.itemTotal || c.breakdownSum !== c.total) {
    out.push({
      check: "amount",
      outcome: "fail",
      severity: "high",
      field: "/breakdown",
      expected: `items ${usd(c.linesSum, cur)}, total ${usd(c.breakdownSum, cur)}`,
      actual: `items ${usd(c.itemTotal, cur)}, total ${usd(c.total, cur)}`,
      reason: "The order's amounts don't add up, so its total can't be trusted.",
    });
  }
  if (c.total > max) {
    out.push({
      check: "amount",
      outcome: "fail",
      severity: "high",
      field: "/total",
      expected: `<= ${usd(max, cur)}`,
      actual: usd(c.total, cur),
      reason: `The all-in total ${usd(c.total, cur)} is over your ${usd(max, cur)} limit${
        c.shipping + c.handling + c.tax + c.insurance > 0
          ? " once shipping, tax and fees are added"
          : ""
      }.`,
    });
  }
  // Fees the user never mentioned: within budget, so not a fail, but worth showing.
  const fees: Array<[string, number]> = [
    ["handling", c.handling],
    ["insurance", c.insurance],
  ];
  for (const [name, cents] of fees) {
    if (cents > 0 && !new RegExp(name, "i").test(spec.rawText)) {
      out.push({
        check: "amount",
        outcome: "warn",
        severity: "medium",
        field: `/breakdown/${name}`,
        expected: "none",
        actual: usd(cents, cur),
        reason: `The order adds a ${usd(cents, cur)} ${name} fee you didn't mention.`,
      });
    }
  }
  if (out.length === 0) {
    out.push({
      check: "amount",
      outcome: "pass",
      severity: "low",
      field: "/total",
      expected: `<= ${usd(max, cur)}`,
      actual: usd(c.total, cur),
      reason: `The all-in total ${usd(c.total, cur)} is within your ${usd(max, cur)} limit.`,
    });
  }
  return out;
}

function currency(spec: IntentSpec, order: NormalizedOrder): Partial[] {
  const ok = order.total.currency === spec.maxTotal.currency;
  return [
    {
      check: "currency",
      outcome: ok ? "pass" : "fail",
      severity: ok ? "low" : "high",
      field: "/total/currency",
      expected: spec.maxTotal.currency,
      actual: order.total.currency,
      reason: ok
        ? `Charged in ${order.total.currency}, as intended.`
        : `Charged in ${order.total.currency}, but your limit is in ${spec.maxTotal.currency}.`,
    },
  ];
}

function quantity(spec: IntentSpec, order: NormalizedOrder): Partial[] {
  const i = primaryLineIndex(order);
  const line = order.lines[i]!;
  const ok = line.quantity === spec.quantity;
  return [
    {
      check: "quantity",
      outcome: ok ? "pass" : "fail",
      severity: ok ? "low" : "high",
      field: `/lines/${i}/quantity`,
      expected: String(spec.quantity),
      actual: String(line.quantity),
      reason: ok
        ? `Quantity ${line.quantity}, as intended.`
        : `The order has ${line.quantity} of ${quote(line.name)}; you asked for ${spec.quantity}.`,
    },
  ];
}

function recurrence(spec: IntentSpec, order: NormalizedOrder): Partial[] {
  if (!spec.oneTimeOnly) {
    return [
      {
        check: "recurrence",
        outcome: "pass",
        severity: "low",
        reason: "Recurring charges are allowed by your intent.",
      },
    ];
  }
  const out: Partial[] = order.lines.flatMap((l, i): Partial[] => {
    const hit = RECURRING.exec(lineText(l));
    if (!hit) return [];
    const inDescription = !RECURRING.test(l.name);
    return [
      {
        check: "recurrence",
        outcome: "fail",
        severity: "high",
        field: `/lines/${i}/${inDescription ? "description" : "name"}`,
        expected: "one-time purchase",
        actual: quote(hit[0]),
        reason: `${quote(l.name)} is a recurring charge ("${hit[0]}"), but you asked for a one-time purchase.`,
      },
    ];
  });
  return out.length
    ? out
    : [
        {
          check: "recurrence",
          outcome: "pass",
          severity: "low",
          expected: "one-time purchase",
          reason: "No line looks like a subscription or recurring charge.",
        },
      ];
}

function condition(spec: IntentSpec, order: NormalizedOrder): Partial[] {
  const allowed = new Set(spec.allowedConditions);
  const out: Partial[] = order.lines.flatMap((l, i): Partial[] => {
    const text = lineText(l);
    const used = USED.exec(text);
    const renewed = RENEWED.exec(text);
    const found =
      used && !allowed.has("used")
        ? { c: "used", m: used }
        : renewed && !allowed.has("renewed")
          ? { c: "renewed", m: renewed }
          : undefined;
    if (!found) return [];
    return [
      {
        check: "condition",
        outcome: "fail",
        severity: "high",
        field: `/lines/${i}/name`,
        expected: spec.allowedConditions.join(" or "),
        actual: `${found.c} (${quote(found.m[0])})`,
        reason: `${quote(l.name)} is ${found.c === "used" ? "used" : "refurbished/renewed"}, but you asked for ${spec.allowedConditions.join(" or ")}.`,
      },
    ];
  });
  return out.length
    ? out
    : [
        {
          check: "condition",
          outcome: "pass",
          severity: "low",
          expected: spec.allowedConditions.join(" or "),
          reason: "Every line is in an allowed condition.",
        },
      ];
}

function addons(spec: IntentSpec, order: NormalizedOrder): Partial[] {
  if (spec.allowAddOns) {
    return [
      {
        check: "addons",
        outcome: "pass",
        severity: "low",
        reason: "Add-ons are allowed by your intent.",
      },
    ];
  }
  const primary = primaryLineIndex(order);
  const out: Partial[] = order.lines.flatMap((l, i): Partial[] => {
    const text = lineText(l);
    const digital = l.category === "DIGITAL_GOODS";
    if (i === primary && !digital) return [];
    const kind = FEE.test(text)
      ? "an extra fee"
      : PROTECTION.test(text)
        ? "a protection plan or warranty"
        : RECURRING.test(text)
          ? "a subscription add-on"
          : digital
            ? "a digital add-on"
            : "an extra item";
    return [
      {
        check: "addons",
        outcome: "fail",
        severity: "high",
        field: `/lines/${i}`,
        expected: "only the item you asked for",
        actual: `${quote(l.name)} (${usd(toCents(l.unitAmount) * l.quantity, l.unitAmount.currency)})`,
        reason: `${quote(l.name)} looks like ${kind} you didn't ask for.`,
      },
    ];
  });
  return out.length
    ? out
    : [
        {
          check: "addons",
          outcome: "pass",
          severity: "low",
          expected: "only the item you asked for",
          reason: "No extra lines, fees or protection plans.",
        },
      ];
}

function merchant(spec: IntentSpec, order: NormalizedOrder, registry: Merchant[]): Partial[] {
  const id = order.merchantId;
  const known = registry.find((m) => m.id === id);
  const base = {
    check: "merchant" as const,
    field: "/merchantId",
    actual: id === UNKNOWN_MERCHANT ? order.merchantDisplayName : id,
  };

  if (spec.blockedMerchants.includes(id)) {
    return [
      {
        ...base,
        outcome: "fail",
        severity: "high",
        expected: `not ${spec.blockedMerchants.join(", ")}`,
        reason: `${quote(order.merchantDisplayName)} is a store you blocked.`,
      },
    ];
  }
  if (spec.allowedMerchants?.length && !spec.allowedMerchants.includes(id)) {
    return [
      {
        ...base,
        outcome: "fail",
        severity: "high",
        expected: spec.allowedMerchants.join(" or "),
        reason: `${quote(order.merchantDisplayName)} isn't one of the stores you allowed.`,
      },
    ];
  }
  if (!known?.verified) {
    return [
      {
        ...base,
        outcome: "warn",
        severity: "medium",
        expected: spec.allowedMerchants?.join(" or ") ?? "a verified merchant",
        reason: known
          ? `${quote(known.displayName)} is not a verified merchant.`
          : `The seller ${quote(order.merchantDisplayName)} isn't in the merchant registry.`,
      },
    ];
  }
  return [
    {
      ...base,
      outcome: "pass",
      severity: "low",
      expected: spec.allowedMerchants?.join(" or ") ?? "a verified merchant",
      reason: `${quote(known.displayName)} is a verified merchant.`,
    },
  ];
}

function lookalike(order: NormalizedOrder, registry: Merchant[]): Partial[] {
  const verified = registry.filter((m) => m.verified);
  const match = findLookalike(order.merchantDisplayName, order.merchantId, verified);
  if (!match) {
    return [
      {
        check: "lookalike",
        outcome: "pass",
        severity: "low",
        field: "/merchantDisplayName",
        actual: order.merchantDisplayName,
        reason: "The seller's name doesn't imitate a verified merchant.",
      },
    ];
  }
  return [
    {
      check: "lookalike",
      outcome: "fail",
      severity: "high",
      field: "/merchantDisplayName",
      expected: match.verifiedName,
      actual: order.merchantDisplayName,
      reason: `The seller ${quote(order.merchantDisplayName)} looks like ${match.verifiedName} but isn't it.`,
      confidence: match.distance === 0 ? 1 : 0.9,
    },
  ];
}

const CHECKS: Array<
  [CheckId, (spec: IntentSpec, order: NormalizedOrder, registry: Merchant[]) => Partial[]]
> = [
  ["amount", (s, o) => amount(s, o)],
  ["currency", (s, o) => currency(s, o)],
  ["quantity", (s, o) => quantity(s, o)],
  ["recurrence", (s, o) => recurrence(s, o)],
  ["condition", (s, o) => condition(s, o)],
  ["addons", (s, o) => addons(s, o)],
  ["merchant", merchant],
  ["lookalike", (_s, o, r) => lookalike(o, r)],
];

/** Runs every deterministic check. Always returns at least one result per check id. */
export function runDeterministic(
  spec: IntentSpec,
  order: NormalizedOrder,
  registry: Merchant[],
): CheckResult[] {
  return CHECKS.flatMap(([, run]) => {
    const t0 = performance.now();
    const results = run(spec, order, registry);
    const latencyMs = Math.round((performance.now() - t0) * 1000) / 1000;
    return results.map((r): CheckResult => ({ ...r, stage: "deterministic", latencyMs }));
  });
}
