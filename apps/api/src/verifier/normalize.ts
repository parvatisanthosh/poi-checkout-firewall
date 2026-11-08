// PayPal order JSON -> NormalizedOrder (CONTRACTS 2). Pure, no I/O.
// Every merchant-written string passes through untouched (it is evidence); checks treat it as data.
import {
  BAZAAR_CUSTOM_ID_PREFIX,
  NormalizedOrder,
  toCents,
  type Money,
  type NormalizedLine,
} from "@poi/shared";
import type { PayPalMoney, PayPalOrder } from "../paypal/schemas";

export const UNKNOWN_MERCHANT = "unknown";

/** Thrown for orders POI refuses to reason about. The pipeline treats it as VOID (fail closed). */
export class NormalizeError extends Error {
  constructor(
    readonly code: "MULTIPLE_PURCHASE_UNITS" | "MIXED_CURRENCY" | "NO_ITEMS",
    message: string,
  ) {
    super(message);
  }
}

const money = (m: PayPalMoney): Money => ({ currency: m.currency_code, value: m.value });
const LINE_CATEGORIES = new Set(["PHYSICAL_GOODS", "DIGITAL_GOODS", "DONATION"]);

export function normalizeOrder(order: PayPalOrder): NormalizedOrder {
  // A second purchase unit is a second charge, possibly to another payee. We verify exactly one.
  if (order.purchase_units.length !== 1) {
    throw new NormalizeError(
      "MULTIPLE_PURCHASE_UNITS",
      `order has ${order.purchase_units.length} purchase units; POI verifies exactly one`,
    );
  }
  const pu = order.purchase_units[0]!;
  const currency = pu.amount.currency_code;
  const items = pu.items ?? [];
  if (items.length === 0) {
    throw new NormalizeError("NO_ITEMS", "order has no line items, so there is nothing to verify");
  }

  const allMoney = [
    pu.amount,
    ...items.flatMap((i) => [i.unit_amount, ...(i.tax ? [i.tax] : [])]),
    ...Object.values(pu.amount.breakdown ?? {}).filter(
      (m): m is PayPalMoney => !!m && typeof m === "object",
    ),
  ];
  if (allMoney.some((m) => m.currency_code !== currency)) {
    throw new NormalizeError("MIXED_CURRENCY", "order mixes currencies");
  }

  const lines: NormalizedLine[] = items.map((i) => ({
    name: i.name,
    ...(i.description ? { description: i.description } : {}),
    ...(i.sku ? { sku: i.sku } : {}),
    unitAmount: money(i.unit_amount),
    quantity: Number(i.quantity),
    ...(i.category && LINE_CATEGORIES.has(i.category)
      ? { category: i.category as NonNullable<NormalizedLine["category"]> }
      : {}),
  }));

  const b = pu.amount.breakdown;
  // No breakdown means PayPal's total is the item total.
  const itemTotal = b?.item_total ? money(b.item_total) : money(pu.amount);
  const discountCents =
    toCents(b?.discount?.value ?? "0") + toCents(b?.shipping_discount?.value ?? "0");

  const customId = pu.custom_id ?? "";
  const merchantId = customId.startsWith(BAZAAR_CUSTOM_ID_PREFIX)
    ? customId.slice(BAZAAR_CUSTOM_ID_PREFIX.length) || UNKNOWN_MERCHANT
    : UNKNOWN_MERCHANT;

  return NormalizedOrder.parse({
    orderId: order.id,
    status: order.status,
    intent: order.intent,
    merchantId,
    // description carries the full display name; soft_descriptor is card-statement text that
    // PayPal may truncate or strip (22 chars, ASCII), hiding homoglyphs from the look-alike check.
    merchantDisplayName:
      pu.description ?? pu.soft_descriptor ?? pu.payee?.email_address ?? "Unknown merchant",
    lines,
    breakdown: {
      itemTotal,
      ...(b?.shipping ? { shipping: money(b.shipping) } : {}),
      ...(b?.handling ? { handling: money(b.handling) } : {}),
      ...(b?.tax_total ? { taxTotal: money(b.tax_total) } : {}),
      ...(b?.insurance ? { insurance: money(b.insurance) } : {}),
      ...(discountCents > 0
        ? { discount: { currency, value: (discountCents / 100).toFixed(2) } }
        : {}),
    },
    total: money(pu.amount),
  });
}

export interface OrderCents {
  total: number;
  itemTotal: number;
  linesSum: number;
  shipping: number;
  handling: number;
  tax: number;
  insurance: number;
  discount: number;
  /** itemTotal + shipping + handling + tax + insurance - discount */
  breakdownSum: number;
  lineTotals: number[];
}

/** All the order's money as integer cents. Never floats. */
export function orderCents(o: NormalizedOrder): OrderCents {
  const c = (m?: Money) => (m ? toCents(m) : 0);
  const lineTotals = o.lines.map((l) => toCents(l.unitAmount) * l.quantity);
  const b = o.breakdown;
  const parts = {
    itemTotal: c(b.itemTotal),
    shipping: c(b.shipping),
    handling: c(b.handling),
    tax: c(b.taxTotal),
    insurance: c(b.insurance),
    discount: c(b.discount),
  };
  return {
    total: c(o.total),
    linesSum: lineTotals.reduce((s, x) => s + x, 0),
    lineTotals,
    ...parts,
    breakdownSum:
      parts.itemTotal +
      parts.shipping +
      parts.handling +
      parts.tax +
      parts.insurance -
      parts.discount,
  };
}
