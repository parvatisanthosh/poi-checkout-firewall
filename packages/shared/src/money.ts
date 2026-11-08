import type { Money } from "./schemas";

/** "12.30" -> 1230. Money is never a float inside POI. */
export function toCents(m: Money | string): number {
  const value = typeof m === "string" ? m : m.value;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error(`Invalid money value: ${value}`);
  const whole = Number(match[1]);
  const frac = Number((match[2] ?? "").padEnd(2, "0"));
  return whole * 100 + frac;
}

/** 1230 -> { currency, value: "12.30" } */
export function fromCents(cents: number, currency = "USD"): Money {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`Invalid cents: ${cents}`);
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  return { currency, value: `${whole}.${frac}` };
}

/** "$12.30" for UI strings. USD-only demo, so a symbol map is enough. */
export function formatMoney(m: Money): string {
  const symbol = m.currency === "USD" ? "$" : `${m.currency} `;
  return `${symbol}${fromCents(toCents(m), m.currency).value}`;
}
