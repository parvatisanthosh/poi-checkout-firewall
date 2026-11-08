// Zod schemas for the PayPal REST shapes POI reads. They validate only the fields we use and
// keep everything else (looseObject), because the raw order is stored as evidence later (P7).
// Field names stay in PayPal's snake_case; the normalizer (P4) maps them to NormalizedOrder.
import { z } from "zod";

export const PayPalMoney = z.looseObject({
  currency_code: z.string().length(3),
  value: z.string().regex(/^\d+(\.\d{1,2})?$/),
});
export type PayPalMoney = z.infer<typeof PayPalMoney>;

export const PayPalLink = z.looseObject({
  href: z.string(),
  rel: z.string(),
  method: z.string().optional(),
});
export type PayPalLink = z.infer<typeof PayPalLink>;

export const PayPalTokenResponse = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().int().positive(),
  app_id: z.string().optional(),
});

// Authorization status: CREATED | CAPTURED | DENIED | PARTIALLY_CAPTURED | VOIDED | PENDING
export const PayPalAuthorization = z.looseObject({
  id: z.string(),
  status: z.string(),
  status_details: z.looseObject({ reason: z.string().optional() }).optional(),
  amount: PayPalMoney.optional(),
  expiration_time: z.string().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(PayPalLink).optional(),
});
export type PayPalAuthorization = z.infer<typeof PayPalAuthorization>;

// Capture status: COMPLETED | DECLINED | PARTIALLY_REFUNDED | PENDING | REFUNDED | FAILED
export const PayPalCapture = z.looseObject({
  id: z.string(),
  status: z.string(),
  status_details: z.looseObject({ reason: z.string().optional() }).optional(),
  amount: PayPalMoney.optional(),
  final_capture: z.boolean().optional(),
  create_time: z.string().optional(),
  links: z.array(PayPalLink).optional(),
});
export type PayPalCapture = z.infer<typeof PayPalCapture>;

export const PayPalItem = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  sku: z.string().optional(),
  url: z.string().optional(),
  unit_amount: PayPalMoney,
  tax: PayPalMoney.optional(),
  quantity: z.string().regex(/^\d+$/),
  category: z.string().optional(), // PHYSICAL_GOODS | DIGITAL_GOODS | DONATION; P4 narrows it
});
export type PayPalItem = z.infer<typeof PayPalItem>;

export const PayPalBreakdown = z.looseObject({
  item_total: PayPalMoney.optional(),
  shipping: PayPalMoney.optional(),
  handling: PayPalMoney.optional(),
  tax_total: PayPalMoney.optional(),
  insurance: PayPalMoney.optional(),
  shipping_discount: PayPalMoney.optional(),
  discount: PayPalMoney.optional(),
});

export const PayPalPurchaseUnit = z.looseObject({
  reference_id: z.string().optional(),
  description: z.string().optional(),
  custom_id: z.string().optional(),
  invoice_id: z.string().optional(),
  soft_descriptor: z.string().optional(),
  amount: PayPalMoney.extend({ breakdown: PayPalBreakdown.optional() }),
  payee: z
    .looseObject({ merchant_id: z.string().optional(), email_address: z.string().optional() })
    .optional(),
  items: z.array(PayPalItem).optional(),
  payments: z
    .looseObject({
      authorizations: z.array(PayPalAuthorization).optional(),
      captures: z.array(PayPalCapture).optional(),
    })
    .optional(),
});
export type PayPalPurchaseUnit = z.infer<typeof PayPalPurchaseUnit>;

// Order status: CREATED | SAVED | APPROVED | VOIDED | COMPLETED | PAYER_ACTION_REQUIRED
export const PayPalOrder = z.looseObject({
  id: z.string(),
  status: z.string(),
  intent: z.enum(["CAPTURE", "AUTHORIZE"]),
  purchase_units: z.array(PayPalPurchaseUnit).min(1),
  links: z.array(PayPalLink).optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
});
export type PayPalOrder = z.infer<typeof PayPalOrder>;

/** Body for POST /v2/checkout/orders. Only used by the smoke script and tests; the Bazaar has its own. */
export interface CreateOrderBody {
  intent: "CAPTURE" | "AUTHORIZE";
  purchase_units: Array<Record<string, unknown>>;
  payment_source?: Record<string, unknown>;
}
