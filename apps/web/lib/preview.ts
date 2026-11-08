import type { NormalizedOrder } from "@poi/shared";

interface Money {
  currency_code: string;
  value: string;
}
interface PreviewUnit {
  description?: string;
  custom_id?: string;
  amount: Money & { breakdown?: Record<string, Money | undefined> };
  items: Array<{
    name: string;
    description?: string;
    sku?: string;
    unit_amount: Money;
    quantity: string;
    category?: string;
  }>;
}

const m = (x?: Money) =>
  x && x.value !== "0.00" ? { currency: x.currency_code, value: x.value } : undefined;

/** The Bazaar's order body -> the same shape POI shows, for the "what the merchant sent" card. */
export function previewToOrder(orderId: string, pu: PreviewUnit): NormalizedOrder {
  const b = pu.amount.breakdown ?? {};
  return {
    orderId,
    status: "CREATED",
    intent: "AUTHORIZE",
    merchantId: (pu.custom_id ?? "").replace(/^bazaar:/, ""),
    merchantDisplayName: pu.description ?? "Merchant",
    lines: pu.items.map((i) => ({
      name: i.name,
      ...(i.description ? { description: i.description } : {}),
      ...(i.sku ? { sku: i.sku } : {}),
      unitAmount: { currency: i.unit_amount.currency_code, value: i.unit_amount.value },
      quantity: Number(i.quantity),
      ...(i.category === "DIGITAL_GOODS" || i.category === "PHYSICAL_GOODS"
        ? { category: i.category }
        : {}),
    })),
    breakdown: {
      itemTotal: m(b.item_total) ?? { currency: "USD", value: "0.00" },
      ...(m(b.shipping) ? { shipping: m(b.shipping) } : {}),
      ...(m(b.handling) ? { handling: m(b.handling) } : {}),
      ...(m(b.tax_total) ? { taxTotal: m(b.tax_total) } : {}),
      ...(m(b.insurance) ? { insurance: m(b.insurance) } : {}),
    },
    total: { currency: pu.amount.currency_code, value: pu.amount.value },
  };
}
