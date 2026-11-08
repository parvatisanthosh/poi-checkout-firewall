// Builds the PayPal Orders v2 request a (sometimes dishonest) merchant would send.
// Integer cents throughout; tax is 8% of the item total, rounded half up.
import { BAZAAR_CUSTOM_ID_PREFIX, fromCents } from "@poi/shared";
import { cents, type BazaarData } from "./data";

export const TAX_RATE_PERCENT = 8;

export interface CheckoutItem {
  sku: string;
  qty: number;
}

export class CheckoutError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const usd = (c: number) => fromCents(c, "USD");
const money = (c: number) => ({ currency_code: "USD", value: usd(c).value });
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
/** soft_descriptor is card-statement text: ASCII letters/digits/spaces, 22 chars. */
const softDescriptor = (name: string) =>
  clip(
    name
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9 ]/g, "")
      .trim(),
    22,
  ) || "BAZAAR";

export function buildOrderRequest(
  data: BazaarData,
  items: CheckoutItem[],
  urls: { returnUrl: string; cancelUrl: string },
) {
  const products = items.map((i) => {
    const p = data.product(i.sku);
    if (!p) throw new CheckoutError(404, "SKU_NOT_FOUND", `Unknown sku ${i.sku}`);
    return { p, qty: i.qty };
  });
  const merchantIds = new Set(products.map(({ p }) => p.merchantId));
  if (merchantIds.size !== 1)
    throw new CheckoutError(400, "MIXED_MERCHANTS", "One checkout = one merchant");
  const merchant = data.merchant([...merchantIds][0]!)!;

  const lines = products.flatMap(({ p, qty }) => [
    {
      name: clip(p.lineName ?? p.title, 127),
      description: clip(p.bullets[0]!, 127),
      sku: p.sku,
      unitCents: cents(p.priceUsd),
      quantity: qty,
      category: "PHYSICAL_GOODS" as const,
    },
    ...(p.checkoutExtras?.lines ?? []).map((l, i) => ({
      name: clip(l.name, 127),
      description: l.description ? clip(l.description, 127) : undefined,
      sku: `${p.sku}-X${i + 1}`,
      unitCents: cents(l.unitUsd),
      quantity: 1,
      category: l.category,
    })),
  ]);
  const itemTotal = lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
  const shipping = products.reduce((s, { p }) => s + cents(p.shippingUsd), 0);
  const handling = products.reduce(
    (s, { p }) => s + cents(p.checkoutExtras?.feesUsd?.handling ?? 0),
    0,
  );
  const insurance = products.reduce(
    (s, { p }) => s + cents(p.checkoutExtras?.feesUsd?.insurance ?? 0),
    0,
  );
  const tax = Math.round((itemTotal * TAX_RATE_PERCENT) / 100);
  const total = itemTotal + shipping + handling + tax + insurance;

  const body = {
    intent: "AUTHORIZE" as const,
    purchase_units: [
      {
        reference_id: "default",
        custom_id: `${BAZAAR_CUSTOM_ID_PREFIX}${merchant.id}`,
        description: clip(merchant.displayName, 127),
        soft_descriptor: softDescriptor(merchant.displayName),
        amount: {
          ...money(total),
          breakdown: {
            item_total: money(itemTotal),
            shipping: money(shipping),
            handling: money(handling),
            tax_total: money(tax),
            insurance: money(insurance),
          },
        },
        items: lines.map((l) => ({
          name: l.name,
          ...(l.description ? { description: l.description } : {}),
          sku: l.sku,
          unit_amount: money(l.unitCents),
          quantity: String(l.quantity),
          category: l.category,
        })),
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: clip(merchant.displayName, 127),
          user_action: "CONTINUE",
          shipping_preference: "NO_SHIPPING",
          return_url: urls.returnUrl,
          cancel_url: urls.cancelUrl,
        },
      },
    },
  };
  return { body, merchantId: merchant.id, totalCents: total };
}
