// Fakes at the edges of an arena trial: the Bazaar's tenant service, the shopping agent and
// PayPal. They reuse the real Bazaar data, page renderer and checkout builder, so the verifier sees
// exactly the order the real Bazaar would create. Everything between them is the real code.
import type { RunShopperResult } from "@poi/agent";
import type { BazaarProduct, Scenario } from "@poi/shared";
import { buildOrderRequest } from "../../bazaar/src/checkout";
import { loadData, type BazaarData, type MerchantRecord } from "../../bazaar/src/data";
import { pageText } from "../../bazaar/src/render-page";
import type { ArenaShopOptions } from "../src/arena/trial.job";
import type { ArenaBazaar } from "../src/lib/bazaar";
import { PayPalError, PayPalOrder, type PayPal } from "../src/paypal";

export const bazaarData = loadData();
export const scenarios: Scenario[] = bazaarData.scenarios;

export interface ArenaFakes {
  bazaar: ArenaBazaar & { created: string[]; deleted: string[] };
  shop: (o: ArenaShopOptions) => Promise<RunShopperResult>;
  paypal: PayPal;
  /** What the shopper does in a tenant. Default: buy the evolved listing. */
  choose: (
    tenant: string,
    evolvedSku: string,
    scenario: Scenario,
  ) => string | null | Error | { agentStopped: string };
  /** Sellers the Bazaar data doesn't have (evolved listings may name their own). */
  merchants: Map<string, MerchantRecord>;
  /** Every PayPal order read, in order (to prove what was and wasn't re-read). */
  orderReads: string[];
}

export function arenaFakes(): ArenaFakes {
  const tenants = new Map<string, { product: BazaarProduct; scenario: Scenario }>();
  const orders = new Map<string, { sku: string; tenant: string }>();
  const created: string[] = [];
  const deleted: string[] = [];

  /** A BazaarData view of one tenant: the scenario's catalog + the evolved product. */
  const merchants = new Map<string, MerchantRecord>();
  const tenantData = (tenant: string): BazaarData => {
    const t = tenants.get(tenant)!;
    return {
      ...bazaarData,
      product: (sku) => (sku === t.product.sku ? t.product : bazaarData.product(sku)),
      merchant: (id) => merchants.get(id) ?? bazaarData.merchant(id),
    };
  };

  const fakes: ArenaFakes = {
    choose: (_tenant, evolvedSku) => evolvedSku,
    merchants,
    orderReads: [],
    bazaar: {
      created,
      deleted,
      async createTenant(tenant, product, baseScenario) {
        const scenario = scenarios.find((s) => s.id === baseScenario);
        if (!scenario) throw new Error(`unknown base scenario ${baseScenario}`);
        const sku = `ARENA-${tenant}`.toUpperCase().replace(/[^A-Z0-9-]/g, "-");
        tenants.set(tenant, { product: { ...product, sku }, scenario });
        created.push(tenant);
        return { sku };
      },
      async deleteTenant(tenant) {
        deleted.push(tenant);
      },
    },
    async shop(o) {
      if (o.scenario) throw new Error("shopper: a trial must scope by tenant, not scenario");
      const tenant = o.tenant;
      const t = tenants.get(tenant);
      if (!t) throw new Error(`shopper: no tenant ${tenant}`);
      const pick = fakes.choose(tenant, t.product.sku, t.scenario);
      if (pick instanceof Error) throw pick;
      if (pick && typeof pick === "object") {
        // like the real agent: a provider failure ends the run with a note, not an exception
        return {
          trace: {
            model: o.model,
            userText: o.userText,
            steps: [
              {
                i: 0,
                type: "text" as const,
                output: `Agent stopped: ${pick.agentStopped}`,
                at: new Date().toISOString(),
              },
            ],
            observedListings: [],
            chosenSkus: [],
          },
        };
      }
      const choice = pick;
      const observed = [...t.scenario.catalog.slice(0, 2), t.product.sku].map((sku) => ({
        sku,
        pageText: pageText(
          sku === t.product.sku ? t.product : bazaarData.product(sku)!,
          tenantData(tenant),
        ),
      }));
      const trace = {
        model: o.model,
        userText: o.userText,
        steps: [],
        observedListings: observed,
        chosenSkus: choice ? [choice] : [],
      };
      if (!choice) return { trace };
      const orderId = `ARENAORDER-${tenant}`.slice(0, 60);
      const merchantId = (choice === t.product.sku ? t.product : bazaarData.product(choice)!)
        .merchantId;
      orders.set(orderId, { sku: choice, tenant });
      return { trace, checkout: { orderId, merchantId, approveUrl: "https://sandbox/approve" } };
    },
    paypal: {
      tokens: { getToken: async () => "tok", invalidate() {} },
      async getOrder(id: string) {
        fakes.orderReads.push(id);
        const o = orders.get(id);
        if (!o) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "no such order");
        const { body } = buildOrderRequest(tenantData(o.tenant), [{ sku: o.sku, qty: 1 }], {
          returnUrl: "http://x",
          cancelUrl: "http://x",
        });
        return PayPalOrder.parse({ id, status: "CREATED", ...body });
      },
    } as unknown as PayPal,
  };
  return fakes;
}
