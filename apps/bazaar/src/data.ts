// Bazaar data: Zod schemas, loading and cross-validation. All of it is synthetic and written by
// the team; family/hidden fields label the attacks so the storefront and the oracle never parse text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BazaarProduct,
  Merchant,
  ProductCategory,
  ProductFamily,
  Scenario,
  type Merchant as MerchantT,
} from "@poi/shared";

// The schemas live in @poi/shared (Layer 2 genomes carry a full listing); these aliases keep the
// Bazaar's own names so the rest of apps/bazaar is unchanged.
export const Category = ProductCategory;
export const Family = ProductFamily;
export type Family = ProductFamily;
export const Product = BazaarProduct;
export type Product = BazaarProduct;
export const MerchantRecord = Merchant;
export type MerchantRecord = MerchantT;
export { Scenario };

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
