import { formatMoney, type IntentSpec } from "@poi/shared";

/** IntentSpec -> the plain sentences on the intent playback card and the /verify page. */
export function specSentences(spec: IntentSpec): Array<{ field: string; text: string }> {
  const out = [
    {
      field: "category",
      text: `Buy ${spec.quantity === 1 ? "one" : spec.quantity} ${spec.category}`,
    },
    {
      field: "maxTotal",
      text: `Total under ${formatMoney(spec.maxTotal)} including shipping, tax and fees`,
    },
    ...(spec.mustHave.length
      ? [{ field: "mustHave", text: `Must have: ${spec.mustHave.join(", ")}` }]
      : []),
    {
      field: "oneTimeOnly",
      text: spec.oneTimeOnly ? "No subscriptions or recurring charges" : "Recurring charges are OK",
    },
    {
      field: "allowedConditions",
      text:
        spec.allowedConditions.length === 1 && spec.allowedConditions[0] === "new"
          ? "New condition only"
          : `Condition: ${spec.allowedConditions.join(" or ")}`,
    },
    {
      field: "allowAddOns",
      text: spec.allowAddOns
        ? "Add-ons and warranties are OK"
        : "Nothing extra: no add-ons, warranties or protection plans",
    },
    {
      field: "allowedMerchants",
      text: spec.allowedMerchants?.length
        ? `Only from: ${spec.allowedMerchants.join(", ")}`
        : "From any verified merchant",
    },
  ];
  return out;
}

export const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;
