import { generateText, Output, type LanguageModel } from "ai";
import type { Ambiguity, IntentSpec, Merchant } from "@poi/shared";
import type { Logger } from "../lib/logger";
import { CompilerDraft } from "./draft";
import { finalize } from "./finalize";
import { ruleDraft } from "./rules";

export const COMPILER_SYSTEM_PROMPT = `You turn a shopper's request into a strict purchase specification.

Rules:
- Never invent a constraint the user did not state. If something is not stated, use null or "unstated".
- maxTotalUsd is the budget exactly as the user stated it (just the number). If no amount is stated
  (e.g. "cheapest", "decent", "not too expensive"), it is null.
- The budget is ALL-IN (items + shipping + tax + fees). If the user says "plus shipping" or "before tax",
  set budgetBasis to "excludes-extras".
- recurrence is "recurring-ok" only if the user explicitly allows a subscription or recurring charge,
  "one-time" if they say one-time / no subscription, otherwise "unstated".
- conditions lists only conditions the user stated ("new", "renewed" for refurbished/renewed/open-box,
  "used"). null if they said nothing about condition.
- addOns is "allowed" only if the user explicitly allows warranties, protection plans or bundles.
- quantity is 1 for "a"/"an"/"one"; null only if genuinely unclear ("some").
- Merchant names only if the user named a store.
- Add a short question to "questions" for anything else that is unclear. Do not ask about budget,
  quantity, condition or recurrence; those are handled separately.
- Currency is always USD.`;

export interface CompileOptions {
  /** Undefined = no model configured: use the rule-based extractor. */
  model?: LanguageModel;
  merchants: Merchant[];
  logger?: Logger;
  timeoutMs?: number;
}

export interface CompileResult {
  draft: IntentSpec;
  ambiguities: Ambiguity[];
  source: "llm" | "rules";
}

/**
 * Fuzzy text -> strict IntentSpec draft. The model proposes; finalize() keeps only what the
 * text supports and turns gaps into questions. If the model is unavailable or fails, the rule
 * extractor takes over: the user reviews and signs the draft either way, and a rules draft
 * errs toward asking more questions, never toward looser constraints.
 */
export async function compileIntent(text: string, opts: CompileOptions): Promise<CompileResult> {
  let draft: CompilerDraft | undefined;
  if (opts.model) {
    try {
      const { output } = await generateText({
        model: opts.model,
        system: COMPILER_SYSTEM_PROMPT,
        prompt: `Shopper request:\n"""\n${text}\n"""`,
        output: Output.object({ schema: CompilerDraft, name: "purchase_spec" }),
        temperature: 0,
        abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
      draft = CompilerDraft.parse(output);
    } catch (err) {
      opts.logger?.warn(
        { err: (err as Error).message },
        "intent compiler model failed; using rules",
      );
    }
  }
  const source = draft ? "llm" : "rules";
  const result = finalize(text, draft ?? ruleDraft(text, opts.merchants), opts.merchants);
  return { ...result, source };
}
