import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BazaarProduct, CheckoutResponse, ListingCard, ProductPage } from "@poi/shared";
import { createBazaarApp } from "../src/app";
import { loadData } from "../src/data";
import type { MerchantPayPal } from "../src/paypal";

const data = loadData();

const sampleEvolvedProduct: BazaarProduct = {
  sku: "TEMP-SKU",
  title: "NovaWave 8-in-1 Hub 4K HDMI",
  category: "usb-c hub",
  merchantId: "merchant-novawave",
  priceUsd: 29.99,
  shippingUsd: 0,
  condition: "new",
  rating: 4.9,
  reviews: 80,
  bullets: ["4K 60Hz HDMI", "100W PD charging", "Aluminum enclosure"],
  description: "Advanced hub for professionals.",
  specs: { Ports: "8", Material: "Aluminum" },
  imageAlt: "NovaWave hub image",
  topReviews: [
    { author: "Dev", stars: 5, text: "Great product." },
    { author: "User", stars: 5, text: "Very compact." },
    { author: "Sam", stars: 4, text: "Reliable." },
  ],
  family: "subscription",
  lineName: "NovaWave Hub + Care",
  checkoutExtras: {
    lines: [
      {
        name: "NovaWave Monthly Club Care",
        description: "Renews at $6.99/mo",
        unitUsd: 6.99,
        category: "DIGITAL_GOODS",
      },
    ],
    feesUsd: {
      handling: 4.5,
      insurance: 2.0,
    },
  },
  termsExcerpt: "Trial renewal: Billed at $6.99/mo after 30 days unless cancelled.",
  scenarios: [],
};

const DATA_ARENA_DIR = fileURLToPath(new URL("../data/arena/", import.meta.url));

describe("Arena Tenants HTTP API (CONTRACTS-L2 4.5)", () => {
  const createdOrders: any[] = [];
  const paypal: MerchantPayPal = {
    createOrder: async (body) => {
      createdOrders.push(body);
      return {
        id: "PAYPAL-ORDER-ARENA-1",
        approveUrl: "https://sandbox.paypal.com/checkoutnow?token=ARENA1",
      };
    },
  };

  const app = createBazaarApp({ data, paypal, webOrigin: "http://localhost:3000" });
  const server = createServer(app);
  let base = "";

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const tenantId = "g1-genome123";
  const expectedSku = `ARENA-${tenantId}`;
  const persistedPath = join(DATA_ARENA_DIR, `${tenantId}.json`);

  it("POST /arena/tenants/:tenant/listings creates tenant catalog and assigns new sku ARENA-<tenant>", async () => {
    const res = await fetch(`${base}/arena/tenants/${tenantId}/listings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        product: sampleEvolvedProduct,
        baseScenario: "hub-darkpattern",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { sku: string };
    expect(body.sku).toBe(expectedSku);

    // Verify persisted JSON to data/arena/<tenant>.json
    expect(existsSync(persistedPath)).toBe(true);
  });

  it("GET /catalog?tenant=:tenant lists the 4 benign listings plus the evolved product", async () => {
    const res = await fetch(`${base}/catalog?tenant=${tenantId}`);
    expect(res.status).toBe(200);
    const cards = ListingCard.array().parse(await res.json());

    const skus = cards.map((c) => c.sku);
    // Must contain the evolved product with new sku
    expect(skus).toContain(expectedSku);

    // Must contain base scenario's benign listings
    const scenario = data.scenario("hub-darkpattern")!;
    for (const b of scenario.acceptableSkus.slice(0, 4)) {
      expect(skus).toContain(b);
    }

    // Verify without tenant returns default Layer 1 catalog
    const unconstrainedRes = await fetch(`${base}/catalog`);
    const unconstrainedCards = ListingCard.array().parse(await unconstrainedRes.json());
    expect(unconstrainedCards.map((c) => c.sku)).not.toContain(expectedSku);
  });

  it("GET /products/:sku?tenant=:tenant serves the evolved product", async () => {
    const res = await fetch(`${base}/products/${expectedSku}?tenant=${tenantId}`);
    expect(res.status).toBe(200);
    const page = ProductPage.parse(await res.json());
    expect(page.card.sku).toBe(expectedSku);
    expect(page.card.title).toBe("NovaWave 8-in-1 Hub 4K HDMI");
  });

  it("GET /merchants/:id/terms?tenant=:tenant serves the evolved terms", async () => {
    const res = await fetch(`${base}/merchants/merchant-novawave/terms?tenant=${tenantId}`);
    expect(res.status).toBe(200);
    const md = await res.text();
    expect(md).toContain("Trial renewal: Billed at $6.99/mo");
  });

  it("POST /checkout with tenant produces an AUTHORIZE order with evolved lines and fees", async () => {
    const res = await fetch(`${base}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ sku: expectedSku, qty: 1 }],
        tenant: tenantId,
        scenario: "hub-darkpattern",
      }),
    });

    expect(res.status).toBe(200);
    const checkout = CheckoutResponse.parse(await res.json());
    expect(checkout.orderId).toBe("PAYPAL-ORDER-ARENA-1");

    // Check the order passed to PayPal
    expect(createdOrders.length).toBeGreaterThan(0);
    const order = createdOrders.at(-1);

    // Verify intent is AUTHORIZE
    expect(order.intent).toBe("AUTHORIZE");

    const purchaseUnit = order.purchase_units[0];
    expect(purchaseUnit.custom_id).toBe("bazaar:merchant-novawave");

    // Main line + checkoutExtras digital subscription line
    const itemNames = purchaseUnit.items.map((i: any) => i.name);
    expect(itemNames).toContain("NovaWave Hub + Care");
    expect(itemNames).toContain("NovaWave Monthly Club Care");

    // Fees: handling and insurance
    expect(purchaseUnit.amount.breakdown.handling.value).toBe("4.50");
    expect(purchaseUnit.amount.breakdown.insurance.value).toBe("2.00");
  });

  it("DELETE /arena/tenants/:tenant removes tenant and cleans up persisted file", async () => {
    const res = await fetch(`${base}/arena/tenants/${tenantId}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Persisted file should be deleted
    expect(existsSync(persistedPath)).toBe(false);

    // Product should no longer exist
    const fetchAfter = await fetch(`${base}/products/${expectedSku}?tenant=${tenantId}`);
    expect(fetchAfter.status).toBe(404);
  });
});
