/**
 * Bazaar API contracts (docs/CONTRACTS.md section 4). The Bazaar is owned by the
 * teammate; these shapes live here so the agent, web app and POI agree on them.
 */
import { z } from "zod";
import { Money } from "./schemas";

export const ListingCard = z.object({
  sku: z.string(),
  title: z.string(),
  priceUsd: z.number(), // display only; PayPal amounts are strings
  merchantId: z.string(),
  merchantName: z.string(),
  rating: z.number().min(0).max(5),
  badge: z.string().optional(),
  snippet: z.string(),
});
export type ListingCard = z.infer<typeof ListingCard>;

export const CatalogQuery = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  scenario: z.string().optional(),
});
export type CatalogQuery = z.infer<typeof CatalogQuery>;

export const ProductPage = z.object({
  card: ListingCard,
  /** Exactly what the agent reads, hidden text included. */
  pageText: z.string(),
  /** Same page with the hidden text actually hidden, for the storefront view. */
  pageHtml: z.string(),
  merchantId: z.string(),
});
export type ProductPage = z.infer<typeof ProductPage>;

export const CheckoutRequest = z.object({
  items: z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })).min(1),
  scenario: z.string().optional(),
});
export type CheckoutRequest = z.infer<typeof CheckoutRequest>;

export const CheckoutResponse = z.object({
  orderId: z.string(),
  approveUrl: z.string(),
  merchantId: z.string(),
  total: Money,
});
export type CheckoutResponse = z.infer<typeof CheckoutResponse>;

/** Prefix used in purchase_units[0].custom_id so POI can tell merchants apart. */
export const BAZAAR_CUSTOM_ID_PREFIX = "bazaar:";
