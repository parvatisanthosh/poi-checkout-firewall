import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CheckResult, IntentSpec, NormalizedOrder, type CheckId } from "@poi/shared";
import { demoSpec, merchants } from "@poi/shared/fixtures";
import { PayPalOrder } from "../src/paypal/schemas";
import { runDeterministic } from "../src/verifier/deterministic";
import { decideVerdict } from "../src/verifier/lattice";
import { normalizeOrder, NormalizeError, orderCents } from "../src/verifier/normalize";

const DIR = join(import.meta.dirname, "fixtures", "orders");
const load = (name: string) =>
  PayPalOrder.parse(JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")));

// demoSpec: "USB-C hub under $40 with 4K HDMI, one-time purchase, new only"
const spec = IntentSpec.parse(demoSpec);

const failing = (checks: CheckResult[]) =>
  [...new Set(checks.filter((c) => c.outcome === "fail").map((c) => c.check))].sort();
const warning = (checks: CheckResult[]) =>
  [...new Set(checks.filter((c) => c.outcome === "warn").map((c) => c.check))].sort();

const EXPECTED: Record<string, { fails: CheckId[]; warns?: CheckId[] }> = {
  benign: { fails: [] },
  "hidden-subscription": { fails: ["addons", "recurrence"] },
  refurbished: { fails: ["condition"] },
  "protection-plan": { fails: ["addons"] },
  "lookalike-seller": { fails: ["lookalike"], warns: ["merchant"] },
  "drip-fee": { fails: ["addons"], warns: ["amount"] },
  "over-budget-shipping": { fails: ["amount"] },
  // Injection is the semantic/shadow stages' job: deterministically this order is clean.
  "injection-only": { fails: [] },
};

describe("fixtures", () => {
  it("covers every fixture file", () => {
    const files = readdirSync(DIR)
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    expect(files).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))("%s", (name, { fails, warns = [] }) => {
    const order = normalizeOrder(load(name));
    const checks = runDeterministic(spec, order, merchants);
    for (const c of checks) CheckResult.parse(c);
    expect(failing(checks)).toEqual([...fails].sort());
    expect(warning(checks)).toEqual([...warns].sort());
    expect(decideVerdict(checks)).toBe(
      fails.length ? "VOID" : warns.length ? "CAPTURE" : "CAPTURE",
    );
    // every check id ran
    expect(new Set(checks.map((c) => c.check))).toEqual(
      new Set([
        "amount",
        "currency",
        "quantity",
        "recurrence",
        "condition",
        "addons",
        "merchant",
        "lookalike",
      ]),
    );
    // every fail says where and why
    for (const c of checks.filter((x) => x.outcome === "fail")) {
      expect(c.field).toMatch(/^\//);
      expect(c.reason.length).toBeGreaterThan(10);
    }
  });

  it("points at the exact offending line", () => {
    const checks = runDeterministic(spec, normalizeOrder(load("hidden-subscription")), merchants);
    const rec = checks.find((c) => c.check === "recurrence" && c.outcome === "fail")!;
    expect(rec.field).toBe("/lines/1/name"); // "membership" is in the name itself
    expect(rec.reason).toContain("Hub Care+ membership");
    const over = runDeterministic(
      spec,
      normalizeOrder(load("over-budget-shipping")),
      merchants,
    ).find((c) => c.check === "amount")!;
    expect(over).toMatchObject({ outcome: "fail", expected: "<= $40.00", actual: "$43.78" });
    expect(over.reason).toMatch(/once shipping, tax and fees are added/);
  });
});

describe("normalizeOrder", () => {
  it("maps PayPal JSON to the contract, money as strings, cents exact", () => {
    const o = normalizeOrder(load("drip-fee"));
    expect(NormalizedOrder.parse(o)).toEqual(o);
    expect(o).toMatchObject({
      merchantId: "orbitek",
      merchantDisplayName: "Orbitek",
      intent: "AUTHORIZE",
    });
    expect(o.lines[1]).toMatchObject({
      name: "Order processing fee",
      category: "DIGITAL_GOODS",
      quantity: 1,
    });
    const c = orderCents(o);
    expect(c).toMatchObject({
      itemTotal: 3448,
      handling: 150,
      tax: 276,
      total: 3874,
      breakdownSum: 3874,
      linesSum: 3448,
    });
  });

  it("fails closed on orders it can't reason about", () => {
    const base = load("benign");
    const two = { ...base, purchase_units: [base.purchase_units[0]!, base.purchase_units[0]!] };
    expect(() => normalizeOrder(two)).toThrow(NormalizeError);
    const noItems = { ...base, purchase_units: [{ ...base.purchase_units[0]!, items: [] }] };
    expect(() => normalizeOrder(noItems)).toThrow(/no line items/);
    const pu = base.purchase_units[0]!;
    const mixed = {
      ...base,
      purchase_units: [
        {
          ...pu,
          items: [{ ...pu.items![0]!, unit_amount: { currency_code: "EUR", value: "32.99" } }],
        },
      ],
    };
    expect(() => normalizeOrder(mixed)).toThrow(/mixes currencies/);
  });

  it("treats a missing or foreign custom_id as an unknown merchant", () => {
    const base = load("benign");
    const o = normalizeOrder({
      ...base,
      purchase_units: [{ ...base.purchase_units[0]!, custom_id: "voltra-official" }],
    });
    expect(o.merchantId).toBe("unknown");
    const checks = runDeterministic(spec, o, merchants);
    expect(checks.find((c) => c.check === "merchant")?.outcome).toBe("warn");
  });
});

describe("deterministic edge cases", () => {
  const benign = () => normalizeOrder(load("benign"));

  it("a total exactly at the limit passes; one cent over fails", () => {
    const at = IntentSpec.parse({ ...spec, maxTotal: { currency: "USD", value: "35.63" } });
    const under = IntentSpec.parse({ ...spec, maxTotal: { currency: "USD", value: "35.62" } });
    expect(failing(runDeterministic(at, benign(), merchants))).toEqual([]);
    expect(failing(runDeterministic(under, benign(), merchants))).toEqual(["amount"]);
  });

  it("detects a breakdown that doesn't add up", () => {
    const o = benign();
    const tampered = { ...o, total: { currency: "USD", value: "10.00" } };
    const amount = runDeterministic(spec, tampered, merchants).filter((c) => c.check === "amount");
    expect(amount.some((c) => c.field === "/breakdown" && c.outcome === "fail")).toBe(true);
  });

  it("honors explicit permissions in the intent", () => {
    const loose = IntentSpec.parse({
      ...spec,
      oneTimeOnly: false,
      allowAddOns: true,
      allowedConditions: ["new", "renewed"],
    });
    expect(
      failing(runDeterministic(loose, normalizeOrder(load("hidden-subscription")), merchants)),
    ).toEqual([]);
    expect(
      failing(runDeterministic(loose, normalizeOrder(load("refurbished")), merchants)),
    ).toEqual([]);
  });

  it("enforces allowed and blocked merchant lists and quantity", () => {
    const onlyNexhub = IntentSpec.parse({ ...spec, allowedMerchants: ["nexhub"] });
    expect(failing(runDeterministic(onlyNexhub, benign(), merchants))).toEqual(["merchant"]);
    const blockVoltra = IntentSpec.parse({ ...spec, blockedMerchants: ["voltra-official"] });
    expect(failing(runDeterministic(blockVoltra, benign(), merchants))).toEqual(["merchant"]);
    const two = IntentSpec.parse({ ...spec, quantity: 2 });
    expect(failing(runDeterministic(two, benign(), merchants))).toEqual(["quantity"]);
  });

  it("is not fooled by text that only resembles a pattern", () => {
    const o = benign();
    const line = {
      ...o.lines[0]!,
      name: "USB-C Hub with surge protection, used by 10k pros, renews nothing",
    };
    const checks = runDeterministic(spec, { ...o, lines: [line] }, merchants);
    // "renews" is a recurrence word on purpose; the rest must not trip condition/addons
    expect(failing(checks)).toEqual(["recurrence"]);
  });
});
