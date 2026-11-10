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

/** Wrap any language model so its calls report usage under `modelId`. */
export function meterModel(model: LanguageModelV4, modelId: string): LanguageModelV4 {
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    async wrapGenerate({ doGenerate }) {
      const sink = usageContext.getStore();
      const result = await doGenerate();
      if (sink) await sink(toUsage(modelId, result.usage));
      return result;
    },
    async wrapStream({ doStream }) {
      // Capture the sink now: stream callbacks may run outside this async context.
      const sink = usageContext.getStore();
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
