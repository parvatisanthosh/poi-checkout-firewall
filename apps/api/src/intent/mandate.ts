// AP2-inspired intent mandate. We borrow AP2's idea of a user-approved, machine-checkable
// statement of what an agent may buy; this is NOT AP2-compliant and we don't claim it is.
import { formatMoney, type IntentMandate, type IntentSpec } from "@poi/shared";

export function buildMandate(
  spec: IntentSpec,
  ids: { intentId: string; specHash: string; issuedAt: Date },
): IntentMandate {
  return {
    type: "poi.intent-mandate/1",
    intentId: ids.intentId,
    specHash: ids.specHash,
    naturalLanguageDescription: describeSpec(spec),
    amountRange: { max: spec.maxTotal },
    recurrence: spec.oneTimeOnly ? "none" : "allowed",
    allowedPayees: spec.allowedMerchants?.length ? spec.allowedMerchants : "any-verified",
    allowedConditions: spec.allowedConditions,
    allowAddOns: spec.allowAddOns,
    humanPresent: spec.humanPresent,
    issuedAt: ids.issuedAt.toISOString(),
  };
}

/**
 * Plain-English playback of what POI will enforce, generated from the spec (not the user's
 * raw text), so the user confirms what the machine understood.
 */
export function describeSpec(spec: IntentSpec): string {
  const parts = [
    `Buy ${spec.quantity} ${spec.category}${spec.mustHave.length ? ` with ${spec.mustHave.join(", ")}` : ""} for at most ${formatMoney(spec.maxTotal)} all-in (shipping, tax and fees included)`,
    spec.oneTimeOnly ? "one-time purchase, no recurring charges" : "recurring charges allowed",
    `condition: ${spec.allowedConditions.join(" or ")}`,
    spec.allowAddOns ? "add-ons allowed" : "no add-ons, warranties or protection plans",
    spec.allowedMerchants?.length
      ? `only from ${spec.allowedMerchants.join(", ")}`
      : "from any verified merchant",
  ];
  if (spec.blockedMerchants.length) parts.push(`never from ${spec.blockedMerchants.join(", ")}`);
  return `${parts.join("; ")}.`;
}
