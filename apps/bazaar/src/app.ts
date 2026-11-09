import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import {
  BazaarProduct,
  CatalogQuery,
  CheckoutRequest,
  fromCents,
  type CheckoutResponse,
} from "@poi/shared";
import { z } from "zod";
import { tenantStore } from "./arena/tenants";
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

function getScopedData(data: BazaarData, tenantId?: string): BazaarData {
  if (!tenantId) return data;
  return {
    ...data,
    product: (sku: string) => tenantStore.getProduct(tenantId, sku, data),
    merchant: (id: string) => {
      const m = data.merchant(id);
      if (m) return m;
      const tenant = tenantStore.get(tenantId);
      if (tenant && tenant.product.merchantId === id) {
        const name = id.replace(/^merchant-/, "").replace(/-/g, " ");
        return {
          id,
          displayName: name.charAt(0).toUpperCase() + name.slice(1),
          verified: false,
        };
      }
      return { id, displayName: id, verified: false };
    },
  };
}

export function createBazaarApp(opts: BazaarOptions) {
  const { data } = opts;
  const app = express();
  app.use(cors({ origin: opts.webOrigin.split(",").map((o) => o.trim()) }));
  app.use(express.json({ limit: "200kb" }));

  const inScenario = (scenarioId?: string) => {
    if (!scenarioId) return data.products;
    const s = data.scenario(scenarioId);
    if (!s) throw new CheckoutError(404, "SCENARIO_NOT_FOUND", `Unknown scenario ${scenarioId}`);
    return s.catalog.map((sku) => data.product(sku)!);
  };

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // --- Layer 2 Arena Tenant Management (CONTRACTS-L2 4.5) -----------------------------------
  app.post("/arena/tenants/:tenant/listings", (req, res) => {
    const tenantId = req.params.tenant;
    const body = z
      .object({
        product: BazaarProduct,
        baseScenario: z.string().min(1),
      })
      .parse(req.body);

    const result = tenantStore.register(tenantId, body.product, body.baseScenario, data);
    res.status(201).json(result);
  });

  app.delete("/arena/tenants/:tenant", (req, res) => {
    const tenantId = req.params.tenant;
    const result = tenantStore.delete(tenantId);
    res.json(result);
  });

  // --- Catalog & Products (Tenant-scoped when tenant param is provided) ----------------------
  app.get("/catalog", (req, res) => {
    const tenant = (req.query.tenant as string | undefined)?.trim();
    const q = CatalogQuery.parse(req.query);

    let pool: Product[];
    if (tenant) {
      const tenantCatalog = tenantStore.getCatalog(tenant, data);
      pool = tenantCatalog ?? inScenario(q.scenario);
    } else {
      pool = inScenario(q.scenario);
    }

    pool = pool.filter((p) => !q.category || p.category === q.category);
    const effectiveData = getScopedData(data, tenant);
    res.json(search(pool, q.q).map((p) => toCard(p, effectiveData)));
  });

  app.get("/products/:sku", (req, res) => {
    const tenant = (req.query.tenant as string | undefined)?.trim();
    const effectiveData = getScopedData(data, tenant);
    const p = effectiveData.product(req.params.sku);
    if (!p) throw new CheckoutError(404, "SKU_NOT_FOUND", `Unknown sku ${req.params.sku}`);
    res.json(productPage(p, effectiveData));
  });

  // Storefront extras: full listing facts for the agent's-eye view.
  app.get("/products/:sku/meta", (req, res) => {
    const tenant = (req.query.tenant as string | undefined)?.trim();
    const effectiveData = getScopedData(data, tenant);
    const p = effectiveData.product(req.params.sku);
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
    const tenant = (req.query.tenant as string | undefined)?.trim();
    const md = tenantStore.getTerms(tenant, req.params.id, data);
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

  // The exact PayPal order body /checkout would send, without calling PayPal.
  app.post("/checkout/preview", (req, res) => {
    const tenant =
      ((req.body?.tenant ?? req.query?.tenant) as string | undefined)?.trim() || undefined;

    const body = CheckoutRequest.parse(req.body);
    const web = opts.webOrigin.split(",")[0]!.trim();
    const effectiveData = getScopedData(data, tenant);
    const {
      body: order,
      merchantId,
      totalCents,
    } = buildOrderRequest(effectiveData, body.items, {
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
    const tenant =
      ((req.body?.tenant ?? req.query?.tenant) as string | undefined)?.trim() || undefined;

    const body = CheckoutRequest.parse(req.body);
    const effectiveData = getScopedData(data, tenant);

    if (body.scenario) {
      let allowedSkus: Set<string>;
      if (tenant) {
        const tenantCatalog = tenantStore.getCatalog(tenant, data);
        allowedSkus = new Set((tenantCatalog ?? inScenario(body.scenario)).map((p) => p.sku));
      } else {
        allowedSkus = new Set(inScenario(body.scenario).map((p) => p.sku));
      }

      const outside = body.items.find((i) => !allowedSkus.has(i.sku));
      if (outside) {
        throw new CheckoutError(
          400,
          "SKU_NOT_IN_SCENARIO",
          `${outside.sku} is not in scenario ${body.scenario}`,
        );
      }
    }

    const web = opts.webOrigin.split(",")[0]!.trim();
    const {
      body: order,
      merchantId,
      totalCents,
    } = buildOrderRequest(effectiveData, body.items, {
      returnUrl: `${web}/shop?paypal=approved`,
      cancelUrl: `${web}/shop?paypal=cancelled`,
    });

    if (!opts.paypal) {
      throw new CheckoutError(
        503,
        "PAYPAL_NOT_CONFIGURED",
        "Set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET for the Bazaar",
      );
    }

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
    if (err instanceof CheckoutError) {
      return void res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof z.ZodError) {
      return void res
        .status(400)
        .json({ error: { code: "VALIDATION_ERROR", message: z.prettifyError(err) } });
    }
    console.error("[bazaar]", (err as Error).message);
    res.status(502).json({ error: { code: "UPSTREAM_ERROR", message: (err as Error).message } });
  };
  app.use(onError);
  return app;
}
