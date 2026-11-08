// Bazaar data: Zod schemas, loading and cross-validation. All of it is synthetic and written by
// the team; family/hidden fields label the attacks so the storefront and the oracle never parse text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const Usd = z
  .number()
  .nonnegative()
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "at most 2 decimals");

export const Category = z.enum(["usb-c hub", "wireless earbuds", "laptop stand"]);
export const Family = z.enum([
  "benign",
  "injection",
  "subscription",
  "variant",
  "addon",
  "lookalike",
  "darkpattern",
]);
export type Family = z.infer<typeof Family>;

export const Product = z.object({
  sku: z.string().regex(/^[A-Z0-9-]+$/),
  title: z.string().min(5),
  category: Category,
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
  family: Family,
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
  scenarios: z.array(z.string()),
});
export type Product = z.infer<typeof Product>;

export const MerchantRecord = z.object({
  id: z.string(),
  displayName: z.string(),
  verified: z.boolean(),
});
export type MerchantRecord = z.infer<typeof MerchantRecord>;

export const Scenario = z.object({
  id: z.string(),
  category: Category,
  family: Family,
  userText: z.string(),
  catalog: z.array(z.string()).min(2),
  acceptableSkus: z.array(z.string()).min(1),
  poisonSku: z.string().optional(),
});
export type Scenario = z.infer<typeof Scenario>;

export interface BazaarData {
  products: Product[];
  merchants: MerchantRecord[];
  scenarios: Scenario[];
  terms: Map<string, string>;
  product(sku: string): Product | undefined;
  merchant(id: string): MerchantRecord | undefined;
  scenario(id: string): Scenario | undefined;
}

export const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));

/** Load and validate everything; throws with a precise message on any inconsistency. */
export function loadData(dir = DATA_DIR): BazaarData {
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
  const products = z.array(Product).parse(read("products.json"));
  const merchants = z
    .object({ merchants: z.array(MerchantRecord) })
    .parse(read("merchants.json")).merchants;
  const scenarios = z.array(Scenario).parse(read("scenarios.json"));

  const bySku = new Map(products.map((p) => [p.sku, p]));
  const byMerchant = new Map(merchants.map((m) => [m.id, m]));
  if (bySku.size !== products.length) throw new Error("duplicate sku in products.json");
  for (const p of products) {
    if (!byMerchant.has(p.merchantId))
      throw new Error(`${p.sku}: unknown merchant ${p.merchantId}`);
  }
  for (const s of scenarios) {
    for (const sku of [...s.catalog, ...s.acceptableSkus, ...(s.poisonSku ? [s.poisonSku] : [])]) {
      const p = bySku.get(sku);
      if (!p) throw new Error(`scenario ${s.id}: unknown sku ${sku}`);
      if (p.category !== s.category)
        throw new Error(`scenario ${s.id}: ${sku} is not a ${s.category}`);
    }
    if (s.acceptableSkus.some((sku) => !s.catalog.includes(sku)))
      throw new Error(`scenario ${s.id}: acceptable sku not in catalog`);
    if (s.poisonSku && s.acceptableSkus.includes(s.poisonSku))
      throw new Error(`scenario ${s.id}: poison sku is acceptable`);
  }

  const terms = new Map<string, string>();
  for (const m of merchants) {
    try {
      terms.set(m.id, readFileSync(join(dir, "terms", `${m.id}.md`), "utf8"));
    } catch {
      // merchants without terms are fine
    }
  }
  return {
    products,
    merchants,
    scenarios,
    terms,
    product: (sku) => bySku.get(sku),
    merchant: (id) => byMerchant.get(id),
    scenario: (id) => scenarios.find((s) => s.id === id),
  };
}

/** Dollars (validated to 2 decimals) -> integer cents. */
export const cents = (usd: number) => Math.round(usd * 100);
