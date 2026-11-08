import { z } from "zod";
import { Condition } from "@poi/shared";

/**
 * What the compiler model fills in. Deliberately NOT IntentSpec: every field is required and
 * "the user didn't say" is an explicit null / "unstated", so the model never has to pick a
 * default. Defaults and ambiguity questions are applied afterwards in code (finalize.ts),
 * where they can't be talked out of. All-required + nullable also fits OpenAI strict mode.
 */
export const CompilerDraft = z.object({
  category: z
    .string()
    .describe('Short lowercase product category, e.g. "usb-c hub". Empty string if unclear.'),
  mustHave: z.array(z.string()).describe("Features the user explicitly requires."),
  niceToHave: z.array(z.string()).describe("Features the user said would be nice but optional."),
  quantity: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("Number of units. 1 for 'a'/'an'. null only if the user is genuinely unclear."),
  maxTotalUsd: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/)
    .nullable()
    .describe('The budget the user stated, as a decimal string like "40". null if none stated.'),
  budgetBasis: z
    .enum(["all-in", "excludes-extras", "unstated"])
    .describe('"excludes-extras" if the user said e.g. "plus shipping" or "before tax".'),
  recurrence: z
    .enum(["one-time", "recurring-ok", "unstated"])
    .describe('"recurring-ok" only if the user explicitly allows a subscription/recurring charge.'),
  conditions: z
    .array(Condition)
    .nullable()
    .describe("Allowed item conditions the user stated. null if the user said nothing."),
  addOns: z
    .enum(["allowed", "not-allowed", "unstated"])
    .describe("Warranties, protection plans, bundles."),
  allowedMerchantNames: z.array(z.string()).describe("Stores the user restricted the purchase to."),
  blockedMerchantNames: z.array(z.string()).describe("Stores the user said to avoid."),
  questions: z
    .array(z.object({ field: z.string(), question: z.string() }))
    .describe("Short clarifying questions for anything else that is unclear."),
});
export type CompilerDraft = z.infer<typeof CompilerDraft>;
