// Request pacing for free-tier keys (LLM_RPM_<PROVIDER>): the per-minute window, and waiting out
// a 429 instead of failing.
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRateLimited, meterModel, pace } from "../src/llm";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const ok = {
  content: [{ type: "text" as const, text: "ok" }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
};

afterEach(() => {
  vi.useRealTimers();
  delete process.env.LLM_RPM_PACEA;
  delete process.env.LLM_RPM_PACEB;
  delete process.env.LLM_RPM_PACEC;
});

describe("pacing", () => {
  it("lets N calls through per minute, then waits for the window to reopen", async () => {
    vi.useFakeTimers();
    process.env.LLM_RPM_PACEA = "2";
    await pace("pacea");
    await pace("pacea");
    let third = false;
    const p = pace("pacea").then(() => (third = true));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(third).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(third).toBe(true);
  });

  it("does nothing without a cap", async () => {
    for (let i = 0; i < 50; i++) await pace("nocap");
  });

  it("recognises rate limits", () => {
    expect(isRateLimited({ statusCode: 429, message: "x" })).toBe(true);
    expect(isRateLimited(new Error("429 You exceeded your current quota"))).toBe(true);
    expect(isRateLimited(new Error("RESOURCE_EXHAUSTED"))).toBe(true);
    expect(isRateLimited(new Error("Invalid API key"))).toBe(false);
  });

  it("with a cap, a 429 is waited out (provider's retryDelay) and the call succeeds", async () => {
    process.env.LLM_RPM_PACEB = "100";
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        if (n++ === 0)
          throw Object.assign(new Error("429 quota"), {
            statusCode: 429,
            responseBody: '{"error":{"details":[{"retryDelay": "0s"}]}}',
          });
        return ok;
      },
    });
    const r = await generateText({
      model: meterModel(model, "paceb:m"),
      prompt: "hi",
      maxRetries: 0,
    });
    expect(r.text).toBe("ok");
    expect(n).toBe(2);
  });

  it("without a cap, a 429 fails as before", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw Object.assign(new Error("429 quota"), { statusCode: 429 });
      },
    });
    await expect(
      generateText({ model: meterModel(model, "pacec:m"), prompt: "hi", maxRetries: 0 }),
    ).rejects.toThrow(/429/);
  });
});
