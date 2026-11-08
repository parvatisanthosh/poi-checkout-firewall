import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMerchantRegistry } from "../src/db/merchant-registry";

const missing = join(tmpdir(), "poi-no-such-merchants.json");
const card = (merchantId: string, merchantName: string) => ({
  sku: "X",
  title: "t",
  priceUsd: 1,
  merchantId,
  merchantName,
  rating: 4,
  snippet: "s",
});
const catalogFetch = (cards: unknown[]) =>
  (async () => new Response(JSON.stringify(cards), { status: 200 })) as unknown as typeof fetch;

describe("loadMerchantRegistry", () => {
  it("prefers merchants.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poi-"));
    const file = join(dir, "merchants.json");
    writeFileSync(
      file,
      JSON.stringify({
        merchants: [
          { id: "a", name: "A Store", verified: true },
          { id: "b", displayName: "B" },
        ],
      }),
    );
    const r = await loadMerchantRegistry({ merchantsJsonPath: file, bazaarUrl: "http://x" });
    expect(r.source).toBe("merchants.json");
    expect(r.merchants).toEqual([
      { id: "a", displayName: "A Store", verified: true },
      { id: "b", displayName: "B", verified: false },
    ]);
  });

  it("never trusts the catalog for the verified flag", async () => {
    const r = await loadMerchantRegistry({
      merchantsJsonPath: missing,
      bazaarUrl: "http://bazaar",
      fetch: catalogFetch([
        card("voltra-official", "Voltra Official"),
        card("voitra-official", "VoItra Official"),
        card("brand-new", "Totally Verified Store"),
        card("brand-new", "dupe"),
      ]),
    });
    expect(r.source).toBe("bazaar-catalog");
    expect(r.merchants).toEqual([
      { id: "voltra-official", displayName: "Voltra Official", verified: true },
      { id: "voitra-official", displayName: "VoItra Official", verified: false },
      { id: "brand-new", displayName: "dupe", verified: false },
    ]);
  });

  it("falls back to fixtures when the Bazaar is down", async () => {
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await loadMerchantRegistry({
      merchantsJsonPath: missing,
      bazaarUrl: "http://x",
      fetch: down,
    });
    expect(r.source).toBe("fixtures");
    expect(r.merchants.some((m) => m.id === "voitra-official" && !m.verified)).toBe(true);
  });
});
