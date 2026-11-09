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

// ---------------------------------------------------------------------------
// Catalog data (moved here from apps/bazaar for Layer 2: genomes carry a full listing).
// ---------------------------------------------------------------------------

/** Display dollars with at most 2 decimals (catalog data; PayPal amounts stay strings). */
const Usd = z
  .number()
  .nonnegative()
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "at most 2 decimals");

export const ProductCategory = z.enum(["usb-c hub", "wireless earbuds", "laptop stand"]);
export type ProductCategory = z.infer<typeof ProductCategory>;

/** Layer 1 families + Layer 2's evolved-only "dripfee" and "tosrenew". */
export const ProductFamily = z.enum([
  "benign",
  "injection",
  "subscription",
  "variant",
  "addon",
  "lookalike",
  "darkpattern",
  "dripfee",
  "tosrenew",
]);
export type ProductFamily = z.infer<typeof ProductFamily>;

/** One Bazaar listing. `family` and `hidden` label the attack so nothing has to parse text. */
export const BazaarProduct = z.object({
  sku: z.string().regex(/^[A-Z0-9-]+$/),
  title: z.string().min(5),
  category: ProductCategory,
  merchantId: z.string(),
  priceUsd: Usd,
  shippingUsd: Usd,
  condition: z.enum(["new", "renewed", "used"]),
  rating: z.number().min(0).max(5),
  reviews: z.number().int().nonnegative(),
  badge: z.string().optional(),
  /** Urgency banner (dark patterns). */
  banner: z.string().optional(),
  bullets: z.array(z.string()).min(1),
  description: z.string(),
  specs: z.record(z.string(), z.string()),
  imageAlt: z.string(),
  topReviews: z
    .array(
      z.object({ author: z.string(), stars: z.number().int().min(1).max(5), text: z.string() }),
    )
    .length(3),
  hidden: z
    .object({ text: z.string(), placement: z.enum(["description", "review", "spec", "alt"]) })
    .optional(),
  family: ProductFamily,
  /** PayPal item name when it differs from the title (e.g. a bundled trial). */
  lineName: z.string().optional(),
  checkoutExtras: z
    .object({
      lines: z.array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          unitUsd: Usd,
          category: z.enum(["PHYSICAL_GOODS", "DIGITAL_GOODS"]),
        }),
      ),
      feesUsd: z.object({ handling: Usd.optional(), insurance: Usd.optional() }).optional(),
    })
    .optional(),
  /** Merchant terms excerpt shipped with an evolved listing (Layer 2 "terms" channel). */
  termsExcerpt: z.string().optional(),
  scenarios: z.array(z.string()).default([]),
});
export type BazaarProduct = z.infer<typeof BazaarProduct>;
export type BazaarProductInput = z.input<typeof BazaarProduct>;

export const ScenarioFamily = z.enum([
  "benign",
  "injection",
  "subscription",
  "variant",
  "addon",
  "lookalike",
  "darkpattern",
]);
export type ScenarioFamily = z.infer<typeof ScenarioFamily>;

/** A benchmark scenario (apps/bazaar/data/scenarios.json). Ground truth = acceptableSkus. */
export const Scenario = z.object({
  id: z.string(),
  category: ProductCategory,
  family: ScenarioFamily,
  userText: z.string(),
  catalog: z.array(z.string()).min(2),
  acceptableSkus: z.array(z.string()).min(1),
  poisonSku: z.string().optional(),
});
export type Scenario = z.infer<typeof Scenario>;
