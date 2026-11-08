import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { CatalogQuery, CheckoutRequest, fromCents, type CheckoutResponse } from "@poi/shared";
import { z } from "zod";
import { buildOrderRequest, CheckoutError } from "./checkout";
import type { BazaarData, Product } from "./data";
import type { MerchantPayPal } from "./paypal";
import { productPage, toCard } from "./render-page";

export interface BazaarOptions {
  data: BazaarData;
  paypal?: MerchantPayPal;
  webOrigin: string;
}

const STOP = new Set([
  "with",
  "under",
  "for",
  "and",
  "the",
  "new",
  "only",
  "one",
  "time",
  "purchase",
  "max",
  "total",
  "a",
  "an",
]);
const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));

/** Keyword relevance, then popularity (what a real store would do). */
function search(products: Product[], q: string | undefined): Product[] {
  if (!q?.trim()) return [...products].sort((a, b) => b.reviews - a.reviews);
  const want = tokens(q);
  return products
    .map((p) => {
      const hay = new Set(tokens(`${p.title} ${p.category} ${p.bullets.join(" ")}`));
      return {
        p,
        score: want.filter((t) => hay.has(t) || [...hay].some((h) => h.startsWith(t))).length,
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.p.reviews - a.p.reviews)
    .map((x) => x.p);
}

export function createBazaarApp(opts: BazaarOptions) {
  const { data } = opts;
  const app = express();
  app.use(cors({ origin: opts.webOrigin.split(",").map((o) => o.trim()) }));
  app.use(express.json({ limit: "100kb" }));

  const inScenario = (scenarioId?: string) => {
    if (!scenarioId) return data.products;
    const s = data.scenario(scenarioId);
    if (!s) throw new CheckoutError(404, "SCENARIO_NOT_FOUND", `Unknown scenario ${scenarioId}`);
    return s.catalog.map((sku) => data.product(sku)!);
  };

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/catalog", (req, res) => {
    const q = CatalogQuery.parse(req.query);
    const pool = inScenario(q.scenario).filter((p) => !q.category || p.category === q.category);
    res.json(search(pool, q.q).map((p) => toCard(p, data)));
  });

  app.get("/products/:sku", (req, res) => {
    const p = data.product(req.params.sku);
    if (!p) throw new CheckoutError(404, "SKU_NOT_FOUND", `Unknown sku ${req.params.sku}`);
    res.json(productPage(p, data));
  });

  // Storefront extras (not used by POI or the agent): full listing facts for the agent's-eye view.
  app.get("/products/:sku/meta", (req, res) => {
    const p = data.product(req.params.sku);
    if (!p) throw new CheckoutError(404, "SKU_NOT_FOUND", `Unknown sku ${req.params.sku}`);
    res.json({
      sku: p.sku,
      family: p.family,
      hidden: p.hidden ?? null,
      banner: p.banner ?? null,
      checkoutExtras: p.checkoutExtras ?? null,
      shippingUsd: p.shippingUsd,
    });
  });

  app.get("/merchants", (_req, res) => {
    res.json(data.merchants);
  });

  app.get("/merchants/:id/terms", (req, res) => {
    const md = data.terms.get(req.params.id);
    if (!md) throw new CheckoutError(404, "TERMS_NOT_FOUND", `No terms for ${req.params.id}`);
    res.type("text/markdown").send(md);
  });

  app.get("/scenarios", (_req, res) => {
    res.json(data.scenarios);
  });

  app.get("/scenarios/:id", (req, res) => {
    const s = data.scenario(req.params.id);
    if (!s) throw new CheckoutError(404, "SCENARIO_NOT_FOUND", `Unknown scenario ${req.params.id}`);
    res.json({ ...s, listings: s.catalog.map((sku) => toCard(data.product(sku)!, data)) });
  });

  // The exact PayPal order body /checkout would send, without calling PayPal. The web app uses it
  // to show "what the merchant actually put in the order" before the buyer approves.
  app.post("/checkout/preview", (req, res) => {
    const body = CheckoutRequest.parse(req.body);
    const web = opts.webOrigin.split(",")[0]!.trim();
    const {
      body: order,
      merchantId,
      totalCents,
    } = buildOrderRequest(data, body.items, {
      returnUrl: `${web}/shop?paypal=approved`,
      cancelUrl: `${web}/shop?paypal=cancelled`,
    });
    res.json({
      merchantId,
      total: fromCents(totalCents, "USD"),
      purchaseUnit: order.purchase_units[0],
    });
  });

  app.post("/checkout", async (req, res) => {
    const body = CheckoutRequest.parse(req.body);
    if (body.scenario) {
      const allowed = new Set(inScenario(body.scenario).map((p) => p.sku));
      const outside = body.items.find((i) => !allowed.has(i.sku));
      if (outside)
        throw new CheckoutError(
          400,
          "SKU_NOT_IN_SCENARIO",
          `${outside.sku} is not in scenario ${body.scenario}`,
        );
    }
    const web = opts.webOrigin.split(",")[0]!.trim();
    const {
      body: order,
      merchantId,
      totalCents,
    } = buildOrderRequest(data, body.items, {
      returnUrl: `${web}/shop?paypal=approved`,
      cancelUrl: `${web}/shop?paypal=cancelled`,
    });
    if (!opts.paypal)
      throw new CheckoutError(
        503,
        "PAYPAL_NOT_CONFIGURED",
        "Set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET for the Bazaar",
      );
    const created = await opts.paypal.createOrder(order);
    const out: CheckoutResponse = {
      orderId: created.id,
      approveUrl: created.approveUrl,
      merchantId,
      total: fromCents(totalCents, "USD"),
    };
    res.json(out);
  });

  app.use((req, res) => {
    res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
  });
  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    if (err instanceof CheckoutError)
      return void res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (err instanceof z.ZodError)
      return void res
        .status(400)
        .json({ error: { code: "VALIDATION_ERROR", message: z.prettifyError(err) } });
    console.error("[bazaar]", (err as Error).message);
    res.status(502).json({ error: { code: "UPSTREAM_ERROR", message: (err as Error).message } });
  };
  app.use(onError);
  return app;
}
