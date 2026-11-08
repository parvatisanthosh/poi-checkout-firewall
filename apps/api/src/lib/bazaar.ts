import { ProductPage, type ListingCard } from "@poi/shared";
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
