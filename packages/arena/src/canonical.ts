/**
 * Canonical text extraction for listings (CONTRACTS-L2 section 4.6).
 *
 * listingText() is the SINGLE canonical function that turns a listing into untrusted
 * text for fingerprinting, MinHash immune memory, and novelty calculation.
 * Never build listing text any other way.
 *
 * Rules:
 * - Join title, bullets, description, specs (k: v), reviews, image alt texts,
 *   terms excerpt, checkout extra line names — in that fixed order, newline-separated.
 * - Normalize with NFKC, lowercase, digits -> #, collapsed whitespace.
 */
import type { BazaarProduct } from "@poi/shared";

export function listingText(p: BazaarProduct): string {
  const parts: string[] = [
    // 1. Title
    p.title ?? "",
    // 2. Bullets
    Array.isArray(p.bullets) ? p.bullets.join("\n") : "",
    // 3. Description
    p.description ?? "",
    // 4. Specs (k: v)
    p.specs && typeof p.specs === "object"
      ? Object.entries(p.specs)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      : "",
    // 5. Reviews
    Array.isArray(p.topReviews)
      ? p.topReviews
          .map((r) => r?.text ?? "")
          .filter(Boolean)
          .join("\n")
      : "",
    // 6. Image alt texts
    p.imageAlt ?? "",
    // 7. Terms excerpt
    p.termsExcerpt ?? "",
    // 8. Checkout extra line names
    [
      ...(p.lineName ? [p.lineName] : []),
      ...(p.checkoutExtras?.lines?.map((l) => l.name) ?? []),
    ]
      .filter(Boolean)
      .join("\n"),
  ];

  return parts
    .join("\n")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\d+/g, "#")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
