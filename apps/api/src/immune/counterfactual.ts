// Counterfactual cost (CONTRACTS-L2 5.5): for an escalated order, what capturing it would have cost
// over 12 months beyond what the user meant to pay -- recurring x 12 + add-ons + fees.
// Example: a $6.99/month plan plus a $4.99 protection add-on = 6.99 x 12 + 4.99 = $88.87.
// Amounts are integer cents until the very end. A recurring charge whose amount can't be read from
// the line or the terms is listed with monthlyUsd null and makes the annual total null
// ("recurring, amount unknown") -- never a guess.
import {
  toCents,
  type Counterfactual,
  type CounterfactualItem,
  type NormalizedOrder,
} from "@poi/shared";
import { RECURRING } from "../verifier/deterministic";
import { orderCents } from "../verifier/normalize";

// "$6.99/mo", "6.99 per month", "$79/year", "then $9.49 monthly"
const PRICE_PERIOD =
  /\$\s?(\d{1,6}(?:\.\d{1,2})?)\s*(?:\/\s?|per\s+|a\s+|each\s+)?(mo|month|monthly|yr|year|annually|yearly|wk|week|weekly)\b/i;
const TERMS_RENEWAL =
  /\b(?:renews?|billed|charged|continues?|rolls over|auto-?extends?)\b[^.$]{0,40}?\$\s?(\d{1,6}(?:\.\d{1,2})?)\s*(?:\/\s?|per\s+|a\s+|each\s+)?(mo|month|monthly|yr|year|annually|yearly|wk|week|weekly)\b/i;
const TERMS_RENEWAL_NO_AMOUNT =
  /\b(?:auto-?renew\w*|renews? automatically|automatically renews?)\b/i;

/** "6.99" -> 699, without floating point. */
export function usdToCents(s: string): number {
  const [whole = "0", frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
}

/** Monthly cents for an amount quoted per period (weekly x 52 / 12, yearly / 12), rounded. */
function monthlyCents(amountCents: number, period: string): number {
  const p = period.toLowerCase();
  if (p.startsWith("y") || p.startsWith("ann")) return Math.round(amountCents / 12);
  if (p.startsWith("w")) return Math.round((amountCents * 52) / 12);
  return amountCents;
}

function parseRecurring(text: string, re = PRICE_PERIOD): number | null {
  const m = re.exec(text);
  return m ? monthlyCents(usdToCents(m[1]!), m[2]!) : null;
}

const usd = (cents: number) => cents / 100;

export function computeCounterfactual(order: NormalizedOrder, termsText?: string): Counterfactual {
  const c = orderCents(order);
  const primary = c.lineTotals.reduce((best, t, i) => (t > c.lineTotals[best]! ? i : best), 0);
  const items: CounterfactualItem[] = [];
  let monthlyKnown = 0;
  let unknown = false;
  let oneOff = 0;

  order.lines.forEach((l, i) => {
    const text = `${l.name} ${l.description ?? ""}`;
    const unit = toCents(l.unitAmount);
    if (RECURRING.test(text)) {
      // A recurring line bills its amount every period: the quoted rate, else the line's price.
      const monthly = parseRecurring(text) ?? (i !== primary && unit > 0 ? unit : null);
      if (monthly === null) unknown = true;
      else monthlyKnown += monthly;
      items.push({ label: l.name, monthlyUsd: monthly === null ? null : usd(monthly) });
    } else if (i !== primary) {
      const cents = unit * l.quantity;
      if (cents > 0) {
        oneOff += cents;
        items.push({ label: l.name, oneOffUsd: usd(cents) });
      }
    }
  });
  for (const [label, cents] of [
    ["Handling fee", c.handling],
    ["Insurance", c.insurance],
  ] as const) {
    if (cents > 0) {
      oneOff += cents;
      items.push({ label, oneOffUsd: usd(cents) });
    }
  }
  if (termsText) {
    const monthly = parseRecurring(termsText, TERMS_RENEWAL);
    if (monthly !== null) {
      monthlyKnown += monthly;
      items.push({ label: "Renewal in the terms", monthlyUsd: usd(monthly) });
    } else if (TERMS_RENEWAL_NO_AMOUNT.test(termsText)) {
      unknown = true;
      items.push({ label: "Renewal in the terms (amount not stated)", monthlyUsd: null });
    }
  }
  return { annualExtraUsd: unknown ? null : usd(monthlyKnown * 12 + oneOff), items };
}
