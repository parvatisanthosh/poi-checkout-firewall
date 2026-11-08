// Turns a CompilerDraft (from the model or from rules) into an IntentSpec + ambiguities.
// This is where "never invent constraints" is enforced in code rather than hoped for in a prompt:
// a model claim the user's text doesn't support is dropped and asked about instead.
import { IntentSpec, type Ambiguity, type Condition, type Merchant } from "@poi/shared";
import type { CompilerDraft } from "./draft";
import {
  MENTIONS_ADDONS,
  MENTIONS_RECURRING,
  MENTIONS_USED_OR_REFURB,
  normName,
  statedQuantity,
  textMentionsAmount,
} from "./rules";

export const DEFAULT_ONE_TIME = "default: one-time only";
export const DEFAULT_NEW_ONLY = "default: new only";

const MAX_QUESTIONS = 6;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function finalize(
  text: string,
  draft: CompilerDraft,
  registry: Merchant[],
): { draft: IntentSpec; ambiguities: Ambiguity[] } {
  const ambiguities: Ambiguity[] = [];
  const ask = (a: Ambiguity) => {
    if (!ambiguities.some((x) => x.field === a.field)) ambiguities.push(a);
  };

  // --- category
  const category = clip(draft.category.trim().toLowerCase(), 60) || "unknown";
  if (category === "unknown") {
    ask({ field: "category", question: "What kind of product are you looking for?" });
  }

  // --- budget (maxTotal is all-in). A number the user never wrote is an invention.
  let maxTotal = "0.00";
  if (draft.maxTotalUsd && textMentionsAmount(text, draft.maxTotalUsd)) {
    maxTotal = Number(draft.maxTotalUsd).toFixed(2);
    if (draft.budgetBasis === "excludes-extras") {
      ask({
        field: "maxTotal",
        question: `Your $${maxTotal} excludes shipping or tax. What's the most you want to pay all-in?`,
      });
    }
  } else {
    ask({
      field: "maxTotal",
      question: "What's the most you want to spend, all-in (shipping and tax included)?",
    });
  }

  // --- quantity: >1 needs an explicit count in the text
  let quantity = draft.quantity ?? 1;
  if (draft.quantity === null) {
    ask({ field: "quantity", question: "How many do you want?", resolvedWith: "default: 1" });
  } else if (
    quantity > 1 &&
    statedQuantity(text) !== quantity &&
    !new RegExp(`\\b${quantity}\\b`).test(text)
  ) {
    quantity = 1;
    ask({ field: "quantity", question: "How many do you want?", resolvedWith: "default: 1" });
  }

  // --- recurrence: allowing a subscription needs the user to have mentioned one
  let oneTimeOnly = true;
  if (draft.recurrence === "recurring-ok" && MENTIONS_RECURRING.test(text)) {
    oneTimeOnly = false;
  } else if (draft.recurrence !== "one-time") {
    ask({
      field: "oneTimeOnly",
      question: "Is a subscription or recurring charge ever OK?",
      resolvedWith: DEFAULT_ONE_TIME,
    });
  }

  // --- condition: anything beyond "new" needs the user to have mentioned it
  let allowedConditions: Condition[] = ["new"];
  const stated = draft.conditions?.length ? [...new Set(draft.conditions)] : undefined;
  const loosens = stated?.some((c) => c !== "new") ?? false;
  if (stated && (!loosens || MENTIONS_USED_OR_REFURB.test(text))) {
    allowedConditions = stated;
  } else {
    ask({
      field: "allowedConditions",
      question: "Is refurbished, renewed or used OK, or new only?",
      resolvedWith: DEFAULT_NEW_ONLY,
    });
  }

  // --- add-ons: allowed only if the user talked about them
  const allowAddOns = draft.addOns === "allowed" && MENTIONS_ADDONS.test(text);

  // --- merchants: names -> registry ids; unknown names are asked about, never guessed
  const resolve = (names: string[], field: string) => {
    const ids: string[] = [];
    for (const name of names) {
      const hit = registry.find((m) => normName(m.displayName) === normName(name) || m.id === name);
      if (hit) ids.push(hit.id);
      else
        ask({
          field,
          question: `I couldn't find a store called "${clip(name, 40)}". Which store did you mean?`,
        });
    }
    return [...new Set(ids)];
  };
  const allowedIds = resolve(draft.allowedMerchantNames, "allowedMerchants");
  const blockedIds = resolve(draft.blockedMerchantNames, "blockedMerchants");

  // --- the model's own clarifying questions, after ours
  for (const q of draft.questions) {
    if (ambiguities.length >= MAX_QUESTIONS) break;
    if (q.field && q.question) ask({ field: clip(q.field, 40), question: clip(q.question, 200) });
  }

  const spec = IntentSpec.parse({
    version: "poi.intent/1",
    rawText: text,
    category,
    mustHave: draft.mustHave
      .map((s) => clip(s.trim(), 80))
      .filter(Boolean)
      .slice(0, 10),
    niceToHave: draft.niceToHave
      .map((s) => clip(s.trim(), 80))
      .filter(Boolean)
      .slice(0, 10),
    quantity,
    maxTotal: { currency: "USD", value: maxTotal },
    oneTimeOnly,
    allowedConditions,
    allowAddOns,
    ...(allowedIds.length ? { allowedMerchants: allowedIds } : {}),
    blockedMerchants: blockedIds,
    humanPresent: true,
    ambiguities,
  });
  return { draft: spec, ambiguities };
}
