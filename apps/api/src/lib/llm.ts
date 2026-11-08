import type { LanguageModel } from "ai";
import { getModel, hasKeyFor } from "@poi/shared/llm";

/**
 * Resolve a "provider:model" id from env to a model, or undefined when it isn't configured
 * or its provider key is missing. Callers decide what "no model" means (the compiler falls
 * back to rules; the judge in P5 must fail closed).
 */
export function modelFromEnv(id: string | undefined): LanguageModel | undefined {
  if (!id) return undefined;
  try {
    return hasKeyFor(id) ? getModel(id) : undefined;
  } catch {
    return undefined; // malformed id
  }
}
