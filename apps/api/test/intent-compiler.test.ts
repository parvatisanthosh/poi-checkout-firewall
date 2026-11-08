import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { merchants } from "@poi/shared/fixtures";
import { getModel } from "@poi/shared/llm";
import { compileIntent } from "../src/intent/compiler";
import type { CompilerDraft } from "../src/intent/draft";
import { DEFAULT_NEW_ONLY, DEFAULT_ONE_TIME } from "../src/intent/finalize";

const fields = (a: { field: string; resolvedWith?: string }[]) => a.map((x) => x.field);
const unresolved = (a: { field: string; resolvedWith?: string }[]) =>
  a.filter((x) => !x.resolvedWith).map((x) => x.field);

// The plan's example sentences. Each `expect` runs against the rule compiler in CI and against
// a real model when RUN_LLM_TESTS=1 and COMPILER_MODEL has a key.
const CASES: Array<{
  text: string;
  check: (r: Awaited<ReturnType<typeof compileIntent>>) => void;
}> = [
  {
    text: "USB-C hub under $40, one-time, new only",
    check: ({ draft, ambiguities }) => {
      expect(draft.maxTotal).toEqual({ currency: "USD", value: "40.00" });
      expect(draft.oneTimeOnly).toBe(true);
      expect(draft.allowedConditions).toEqual(["new"]);
      expect(draft.category).toContain("hub");
      expect(unresolved(ambiguities)).toEqual([]);
    },
  },
  {
    text: "get me a decent hub",
    check: ({ draft, ambiguities }) => {
      expect(unresolved(ambiguities)).toContain("maxTotal");
      expect(draft.maxTotal.value).toBe("0.00");
    },
  },
  {
    text: "the cheapest usb-c hub with 4K HDMI",
    check: ({ draft, ambiguities }) => {
      expect(unresolved(ambiguities)).toContain("maxTotal");
      expect(draft.mustHave.join(" ")).toMatch(/4K/i);
    },
  },
  {
    text: "wireless earbuds under $60, a subscription is fine",
    check: ({ draft, ambiguities }) => {
      expect(draft.oneTimeOnly).toBe(false);
      expect(draft.maxTotal.value).toBe("60.00");
      expect(fields(ambiguities)).not.toContain("oneTimeOnly");
    },
  },
  {
    text: "usb-c hubs for the office, 2 of them, under $80 total",
    check: ({ draft }) => {
      expect(draft.quantity).toBe(2);
      expect(draft.maxTotal.value).toBe("80.00");
    },
  },
  {
    text: "aluminium laptop stand under $45, refurbished is ok",
    check: ({ draft }) => {
      expect(draft.allowedConditions).toContain("renewed");
      expect(draft.allowedConditions).not.toContain("used");
    },
  },
  {
    text: "usb-c hub for $40 plus shipping",
    check: ({ draft, ambiguities }) => {
      expect(draft.maxTotal.value).toBe("40.00"); // the stricter reading until the user answers
      expect(unresolved(ambiguities)).toContain("maxTotal");
    },
  },
  {
    text: "USB-C hub with 100W PD for 35 dollars from Voltra Official",
    check: ({ draft }) => {
      expect(draft.maxTotal.value).toBe("35.00");
      expect(draft.mustHave.join(" ")).toMatch(/100\s?W/i);
      expect(draft.allowedMerchants).toEqual(["voltra-official"]);
    },
  },
];

describe("compileIntent (rules, no model)", () => {
  it.each(CASES)("$text", async ({ text, check }) => {
    const r = await compileIntent(text, { merchants });
    expect(r.source).toBe("rules");
    expect(r.draft.rawText).toBe(text);
    expect(r.draft.ambiguities).toEqual(r.ambiguities);
    check(r);
  });

  it("records the safe defaults as resolved ambiguities for the playback card", async () => {
    const { draft, ambiguities } = await compileIntent("a usb-c hub under $40", { merchants });
    expect(draft.oneTimeOnly).toBe(true);
    expect(draft.allowedConditions).toEqual(["new"]);
    expect(ambiguities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "oneTimeOnly", resolvedWith: DEFAULT_ONE_TIME }),
        expect.objectContaining({ field: "allowedConditions", resolvedWith: DEFAULT_NEW_ONLY }),
      ]),
    );
  });
});

function mockModel(draft: CompilerDraft | string) {
  const text = typeof draft === "string" ? draft : JSON.stringify(draft);
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

const base: CompilerDraft = {
  category: "usb-c hub",
  mustHave: [],
  niceToHave: [],
  quantity: 1,
  maxTotalUsd: null,
  budgetBasis: "unstated",
  recurrence: "unstated",
  conditions: null,
  addOns: "unstated",
  allowedMerchantNames: [],
  blockedMerchantNames: [],
  questions: [],
};

describe("compileIntent (model output is checked against the text)", () => {
  it("uses the model when it is honest", async () => {
    const r = await compileIntent("usb-c hub under $40, one-time", {
      merchants,
      model: mockModel({
        ...base,
        maxTotalUsd: "40",
        budgetBasis: "all-in",
        recurrence: "one-time",
        mustHave: ["4K HDMI"],
      }),
    });
    expect(r.source).toBe("llm");
    expect(r.draft.maxTotal.value).toBe("40.00");
    expect(r.draft.mustHave).toEqual(["4K HDMI"]);
  });

  it("drops a budget the user never stated", async () => {
    const r = await compileIntent("get me a decent hub", {
      merchants,
      model: mockModel({ ...base, maxTotalUsd: "50", budgetBasis: "all-in" }),
    });
    expect(r.draft.maxTotal.value).toBe("0.00");
    expect(unresolved(r.ambiguities)).toContain("maxTotal");
  });

  it("refuses to loosen recurrence, condition or add-ons the user never mentioned", async () => {
    const r = await compileIntent("usb-c hub under $40", {
      merchants,
      model: mockModel({
        ...base,
        maxTotalUsd: "40",
        recurrence: "recurring-ok",
        conditions: ["new", "renewed", "used"],
        addOns: "allowed",
      }),
    });
    expect(r.draft.oneTimeOnly).toBe(true);
    expect(r.draft.allowedConditions).toEqual(["new"]);
    expect(r.draft.allowAddOns).toBe(false);
  });

  it("does not guess unknown merchants or inflate quantity", async () => {
    const r = await compileIntent("a hub under $40 from Hubzilla", {
      merchants,
      model: mockModel({
        ...base,
        maxTotalUsd: "40",
        quantity: 3,
        allowedMerchantNames: ["Hubzilla"],
      }),
    });
    expect(r.draft.quantity).toBe(1);
    expect(r.draft.allowedMerchants).toBeUndefined();
    expect(fields(r.ambiguities)).toContain("allowedMerchants");
  });

  it("falls back to rules when the model returns garbage", async () => {
    const r = await compileIntent("usb-c hub under $40", {
      merchants,
      model: mockModel("not json"),
    });
    expect(r.source).toBe("rules");
    expect(r.draft.maxTotal.value).toBe("40.00");
  });
});

const llmId = process.env.COMPILER_MODEL;
describe.runIf(process.env.RUN_LLM_TESTS === "1" && !!llmId)("compileIntent (real model)", () => {
  it.each(CASES)(
    "$text",
    async ({ text, check }) => {
      const r = await compileIntent(text, { merchants, model: getModel(llmId!) });
      expect(r.source).toBe("llm");
      check(r);
    },
    30_000,
  );
});
