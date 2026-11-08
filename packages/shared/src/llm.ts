/**
 * One model id format everywhere: "provider:model", e.g. "openai:gpt-4o-mini".
 * Server-only (reads API keys from env). Import from "@poi/shared/llm", never from the browser.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { groq } from "@ai-sdk/groq";
import { openai } from "@ai-sdk/openai";

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

/** Resolve "provider:model" to a Vercel AI SDK language model. */
export function getModel(id: string) {
  const { provider, model } = parseModelId(id);
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
