// Where the merchant registry (id, display name, verified flag) comes from, in priority order:
//   1. apps/bazaar/data/merchants.json  -- the team-curated registry, has the verified flag
//   2. GET {BAZAAR_URL}/catalog          -- merchant ids/names from a running Bazaar
//   3. @poi/shared fixtures              -- so a fresh clone seeds without the Bazaar
//
// The Bazaar is the adversarial side: its catalog is merchant-written. So the catalog may tell
// us which merchant ids exist, but never whether one is verified. A catalog merchant is
// verified only if the curated registry (file or fixtures) says so by id; otherwise false,
// which is the strict default (unverified merchants get extra scrutiny, never less).
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { ListingCard, type Merchant } from "@poi/shared";
import { merchants as fixtureMerchants } from "@poi/shared/fixtures";

const RegistryEntry = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    verified: z.boolean().default(false),
  })
  .refine((m) => m.displayName ?? m.name, { message: "displayName (or name) is required" })
  .transform((m): Merchant => ({
    id: m.id,
    displayName: (m.displayName ?? m.name)!,
    verified: m.verified,
  }));

const RegistryFile = z.union([
  z.array(RegistryEntry),
  z.object({ merchants: z.array(RegistryEntry) }).transform((f) => f.merchants),
]);

export type RegistrySource = "merchants.json" | "bazaar-catalog" | "fixtures";

export interface LoadRegistryOptions {
  merchantsJsonPath: string;
  bazaarUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export async function loadMerchantRegistry(
  opts: LoadRegistryOptions,
): Promise<{ source: RegistrySource; merchants: Merchant[] }> {
  if (existsSync(opts.merchantsJsonPath)) {
    const json: unknown = JSON.parse(readFileSync(opts.merchantsJsonPath, "utf8"));
    return { source: "merchants.json", merchants: dedupe(RegistryFile.parse(json)) };
  }

  if (opts.bazaarUrl) {
    const catalog = await fetchCatalog(opts.bazaarUrl, opts.fetch ?? fetch, opts.timeoutMs ?? 3000);
    if (catalog && catalog.length > 0) {
      const curated = new Map(fixtureMerchants.map((m) => [m.id, m]));
      const merchants = catalog.map((card) => ({
        id: card.merchantId,
        displayName: curated.get(card.merchantId)?.displayName ?? card.merchantName,
        verified: curated.get(card.merchantId)?.verified ?? false,
      }));
      return { source: "bazaar-catalog", merchants: dedupe(merchants) };
    }
  }

  return { source: "fixtures", merchants: dedupe(fixtureMerchants) };
}

async function fetchCatalog(baseUrl: string, doFetch: typeof fetch, timeoutMs: number) {
  try {
    const res = await doFetch(`${baseUrl.replace(/\/+$/, "")}/catalog`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const parsed = z.array(ListingCard).safeParse(await res.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined; // Bazaar not running
  }
}

function dedupe(list: Merchant[]): Merchant[] {
  return [...new Map(list.map((m) => [m.id, m])).values()];
}
