import { describe, expect, it } from "vitest";
import * as fx from "../src/fixtures";
import {
  AgentTrace,
  CheckResult,
  IntentMandate,
  IntentSpec,
  Merchant,
  Money,
  NormalizedOrder,
  VerificationResult,
} from "../src/schemas";
import { fromCents, toCents } from "../src/money";
import { parseModelId, parseModelList } from "../src/llm";

describe("fixtures conform to the contracts", () => {
  it.each([
    ["demoSpec", IntentSpec, fx.demoSpec],
    ["demoMandate", IntentMandate, fx.demoMandate],
    ["voidOrder", NormalizedOrder, fx.voidOrder],
    ["captureOrder", NormalizedOrder, fx.captureOrder],
    ["demoVoidVerification", VerificationResult, fx.demoVoidVerification],
    ["poisonedTrace", AgentTrace, fx.poisonedTrace],
    ["benignTrace", AgentTrace, fx.benignTrace],
  ] as const)("%s", (_name, schema, value) => {
    expect(() => schema.parse(value)).not.toThrow();
  });

  it("checks and merchants", () => {
    for (const c of [...fx.voidChecks, ...fx.captureChecks]) CheckResult.parse(c);
    for (const m of fx.merchants) Merchant.parse(m);
  });

  it("demo VOID verification has 4 checks", () => {
    expect(fx.demoVoidVerification.checks).toHaveLength(4);
    expect(fx.demoVoidVerification.verdict).toBe("VOID");
  });

  it("fixture order totals add up", () => {
    for (const o of [fx.voidOrder, fx.captureOrder]) {
      const items = o.lines.reduce((s, l) => s + toCents(l.unitAmount) * l.quantity, 0);
      expect(items).toBe(toCents(o.breakdown.itemTotal));
      const b = o.breakdown;
      const total =
        toCents(b.itemTotal) +
        toCents(b.shipping ?? "0") +
        toCents(b.handling ?? "0") +
        toCents(b.taxTotal ?? "0") +
        toCents(b.insurance ?? "0") -
        toCents(b.discount ?? "0");
      expect(total).toBe(toCents(o.total));
    }
  });
});

describe("IntentSpec defaults", () => {
  it("fills safe defaults for a minimal spec", () => {
    const spec = IntentSpec.parse({
      version: "poi.intent/1",
      rawText: "a hub",
      category: "usb-c hub",
      maxTotal: { currency: "USD", value: "40" },
    });
    expect(spec.oneTimeOnly).toBe(true);
    expect(spec.allowedConditions).toEqual(["new"]);
    expect(spec.allowAddOns).toBe(false);
    expect(spec.quantity).toBe(1);
  });
});

describe("Money", () => {
  it("accepts PayPal strings, rejects floats and junk", () => {
    expect(Money.safeParse({ currency: "USD", value: "39.94" }).success).toBe(true);
    expect(Money.safeParse({ currency: "USD", value: "1.999" }).success).toBe(false);
    expect(Money.safeParse({ currency: "USD", value: 39.94 }).success).toBe(false);
    expect(Money.safeParse({ currency: "US", value: "1" }).success).toBe(false);
  });

  it("round-trips cents without float error", () => {
    expect(toCents("0.1")).toBe(10);
    expect(toCents({ currency: "USD", value: "39.94" })).toBe(3994);
    expect(fromCents(3994).value).toBe("39.94");
    expect(fromCents(5).value).toBe("0.05");
    expect(() => toCents("1.234")).toThrow();
  });
});

describe("model ids", () => {
  it("parses provider:model", () => {
    expect(parseModelId("openai:gpt-4o-mini")).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(parseModelId("groq:llama-3.3-70b-versatile").provider).toBe("groq");
  });

  it("rejects bad ids", () => {
    expect(() => parseModelId("gpt-4o")).toThrow();
    expect(() => parseModelId("acme:thing")).toThrow();
    expect(() => parseModelId("openai:")).toThrow();
  });

  it("parses comma lists", () => {
    expect(parseModelList(" openai:a, google:b ,")).toEqual(["openai:a", "google:b"]);
    expect(parseModelList(undefined)).toEqual([]);
  });
});
