/**
 * One model id format everywhere: "provider:model", e.g. "openai:gpt-4o-mini".
 * Server-only (reads API keys from env). Import from "@poi/shared/llm", never from the browser.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { groq } from "@ai-sdk/groq";
import { openai } from "@ai-sdk/openai";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  defaultEmbeddingSettingsMiddleware,
  wrapEmbeddingModel,
  wrapLanguageModel,
  type LanguageModelMiddleware,
} from "ai";

/** The model type wrapLanguageModel works with (avoids a direct @ai-sdk/provider dependency). */
type LanguageModelV4 = Parameters<typeof wrapLanguageModel>[0]["model"];

export const PROVIDERS = ["openai", "anthropic", "google", "groq"] as const;
export type Provider = (typeof PROVIDERS)[number];

const KEY_ENV: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  groq: "GROQ_API_KEY",
};

export function parseModelId(id: string): { provider: Provider; model: string } {
  const idx = id.indexOf(":");
  if (idx <= 0 || idx === id.length - 1) {
    throw new Error(`Model id must look like "provider:model", got "${id}"`);
  }
  const provider = id.slice(0, idx);
  const model = id.slice(idx + 1);
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `Unknown provider "${provider}" in "${id}". Use one of: ${PROVIDERS.join(", ")}`,
    );
  }
  return { provider: provider as Provider, model };
}

/** True when the API key for this model's provider is set. */
export function hasKeyFor(id: string, env: Record<string, string | undefined> = process.env) {
  return Boolean(env[KEY_ENV[parseModelId(id).provider]]);
}

// ---------------------------------------------------------------------------------------------
// Usage metering. Every model from getModel() reports its token usage to the sink of the current
// async context, if there is one. The API's withBudget() (Layer 2 arena) sets that sink, so every
// LLM call made inside a budgeted job is charged -- including calls made by the agent, the judge
// and @poi/arena, which only ever see model ids. Outside withUsageSink nothing happens.
// ---------------------------------------------------------------------------------------------

export interface ModelUsage {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}
/** May throw (e.g. BudgetExceeded): the error propagates out of the LLM call that reported. */
export type UsageSink = (u: ModelUsage) => void | Promise<void>;

const usageContext = new AsyncLocalStorage<UsageSink>();

/** Run `fn` with every metered model call inside it reporting to `sink`. */
export function withUsageSink<T>(sink: UsageSink, fn: () => Promise<T>): Promise<T> {
  return usageContext.run(sink, fn);
}

type Usage = { inputTokens: { total?: number }; outputTokens: { total?: number } };
const toUsage = (modelId: string, u: Usage): ModelUsage => ({
  modelId,
  inputTokens: u.inputTokens.total ?? 0,
  outputTokens: u.outputTokens.total ?? 0,
});

// ---------------------------------------------------------------------------------------------
// Request pacing for free-tier keys. LLM_RPM_<PROVIDER> (e.g. LLM_RPM_GOOGLE=12) caps requests per
// minute for that provider across the whole process -- agent, judge, shadow, compiler, attacker --
// with a 60-second sliding window. When a cap is set, a 429 from that provider is waited out (its
// suggested retry delay, up to 3 times) instead of failing the call. Unset = no pacing, no waiting.
// ---------------------------------------------------------------------------------------------

const rpmFor = (p: string, env: Record<string, string | undefined> = process.env) =>
  Math.max(0, Number(env[`LLM_RPM_${p.toUpperCase()}`] ?? 0) || 0);

const recent = new Map<string, number[]>();

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Wait until `provider` has room under its per-minute cap, then take a slot. */
export async function pace(provider: string, signal?: AbortSignal): Promise<void> {
  const rpm = rpmFor(provider);
  if (!rpm) return;
  const q = recent.get(provider) ?? [];
  recent.set(provider, q);
  for (;;) {
    const now = Date.now();
    while (q.length && now - q[0]! >= 60_000) q.shift();
    if (q.length < rpm) {
      q.push(now); // check and take happen in one synchronous step: no race between callers
      return;
    }
    await sleep(60_000 - (now - q[0]!) + 50, signal);
  }
}

/** A provider's "slow down" answer: HTTP 429 or a quota / rate-limit message. */
export function isRateLimited(err: unknown): boolean {
  const e = err as { statusCode?: number; message?: string } | null;
  if (!e) return false;
  return (
    e.statusCode === 429 || /\b429\b|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(e.message ?? "")
  );
}

/** The provider's suggested wait ("retryDelay": "23s"), else 20s, capped at 65s. */
function retryAfterMs(err: unknown): number {
  const body = String((err as { responseBody?: string } | null)?.responseBody ?? "");
  const s = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(body)?.[1];
  return Math.min(65_000, (s ? Number(s) : 20) * 1000 + 500);
}

/** Wrap any language model so its calls report usage under `modelId` (and are paced, if capped). */
export function meterModel(model: LanguageModelV4, modelId: string): LanguageModelV4 {
  const provider = modelId.split(":")[0] ?? "";
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    async wrapGenerate({ doGenerate, params }) {
      const sink = usageContext.getStore();
      const signal = params.abortSignal;
      let result: Awaited<ReturnType<typeof doGenerate>> | undefined;
      for (let attempt = 0; ; attempt++) {
        await pace(provider, signal);
        try {
          result = await doGenerate();
          break;
        } catch (err) {
          if (!rpmFor(provider) || !isRateLimited(err) || attempt >= 3) throw err;
          await sleep(retryAfterMs(err), signal);
        }
      }
      if (sink) await sink(toUsage(modelId, result.usage));
      return result;
    },
    async wrapStream({ doStream, params }) {
      // Capture the sink now: stream callbacks may run outside this async context.
      const sink = usageContext.getStore();
      await pace(provider, params.abortSignal);
      const result = await doStream();
      if (!sink) return result;
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            async transform(part, controller) {
              if (part.type === "finish") await sink(toUsage(modelId, part.usage));
              controller.enqueue(part);
            },
          }),
        ),
      };
    },
  };
  return wrapLanguageModel({ model, middleware });
}

function providerModel(provider: Provider, model: string): LanguageModelV4 {
  switch (provider) {
    case "openai":
      return openai(model);
    case "anthropic":
      return anthropic(model);
    case "google":
      return google(model);
    case "groq":
      return groq(model);
  }
}

/** Resolve "provider:model" to a (usage-metered) Vercel AI SDK language model. */
export function getModel(id: string): LanguageModelV4 {
  const { provider, model } = parseModelId(id);
  return meterModel(providerModel(provider, model), id);
}

/** Comma list from env (AGENT_MODELS) -> validated ids. */
export function parseModelList(list: string | undefined): string[] {
  return (list ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => {
      parseModelId(id);
      return id;
    });
}

/** Dimensions of TermsChunk.embedding (vector(1536)). */
export const EMBEDDING_DIMS = 1536;

/**
 * Resolve "provider:model" to an embedding model that returns EMBEDDING_DIMS-long vectors,
 * the size of TermsChunk.embedding:
 *   - openai:text-embedding-3-small (1536 natively)
 *   - google:gemini-embedding-001 (free tier; asked for 1536 via outputDimensionality)
 */
export function getEmbeddingModel(id: string) {
  const { provider, model } = parseModelId(id);
  if (provider === "openai") return openai.embeddingModel(model);
  if (provider === "google") {
    return wrapEmbeddingModel({
      model: google.embeddingModel(model),
      middleware: defaultEmbeddingSettingsMiddleware({
        settings: { providerOptions: { google: { outputDimensionality: EMBEDDING_DIMS } } },
      }),
    });
  }
  throw new Error(
    `Embeddings need a ${EMBEDDING_DIMS}-dim model: use google:gemini-embedding-001 or openai:text-embedding-3-small (got "${id}")`,
  );
}
