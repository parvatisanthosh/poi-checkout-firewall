import { z } from "zod";
import { ProductPage, Scenario, type BazaarProduct, type ListingCard } from "@poi/shared";
import { env } from "../env";

/**
 * Structured listing fields for the shadow stage's spec-best ranker. Best effort: the Bazaar is
 * merchant-side, so a missing or malformed answer just means "rank from page text instead".
 */
export async function fetchListingCard(
  sku: string,
  baseUrl = env.BAZAAR_URL,
): Promise<ListingCard | undefined> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/products/${encodeURIComponent(sku)}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return undefined;
    const parsed = ProductPage.safeParse(await res.json());
    return parsed.success ? parsed.data.card : undefined;
  } catch {
    return undefined;
  }
}

/** The Bazaar's benchmark scenarios (arena generations pick their base scenario from these). */
export async function fetchScenarios(baseUrl = env.BAZAAR_URL): Promise<Scenario[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/scenarios`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const parsed = Scenario.array().safeParse(await res.json());
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** The Bazaar's arena tenants (CONTRACTS-L2 4.5, built by the teammate in apps/bazaar/src/arena). */
export interface ArenaBazaar {
  /** Register an evolved listing in an isolated catalog; returns the SKU it was given there. */
  createTenant(
    tenant: string,
    product: BazaarProduct,
    baseScenario: string,
  ): Promise<{ sku: string }>;
  deleteTenant(tenant: string): Promise<void>;
}

const TenantCreated = z.object({ sku: z.string() });

export class BazaarHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function httpArenaBazaar(baseUrl = env.BAZAAR_URL): ArenaBazaar {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    async createTenant(tenant, product, baseScenario) {
      const res = await fetch(`${base}/arena/tenants/${encodeURIComponent(tenant)}/listings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product, baseScenario }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok)
        throw new BazaarHttpError(res.status, `Bazaar tenant ${tenant}: HTTP ${res.status}`);
      return TenantCreated.parse(await res.json());
    },
    async deleteTenant(tenant) {
      const res = await fetch(`${base}/arena/tenants/${encodeURIComponent(tenant)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok && res.status !== 404)
        throw new BazaarHttpError(res.status, `Bazaar delete ${tenant}: HTTP ${res.status}`);
    },
  };
}
