// Minimal PayPal client for the merchant side: client-credentials OAuth (cached, single-flight)
// and order creation with a PayPal-Request-Id. Never logs tokens or secrets.
import { randomUUID } from "node:crypto";
import { z } from "zod";

const Token = z.object({ access_token: z.string(), expires_in: z.number() });
const CreatedOrder = z.looseObject({
  id: z.string(),
  status: z.string(),
  links: z.array(z.looseObject({ href: z.string(), rel: z.string() })).optional(),
});

export interface MerchantPayPal {
  createOrder(body: unknown): Promise<{ id: string; approveUrl: string }>;
}

export function createMerchantPayPal(cfg: {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  fetch?: typeof fetch;
}): MerchantPayPal {
  const doFetch = cfg.fetch ?? fetch;
  const base = cfg.baseUrl.replace(/\/+$/, "");
  let cached: { token: string; exp: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function token(): Promise<string> {
    if (cached && Date.now() < cached.exp - 60_000) return cached.token;
    inflight ??= (async () => {
      const res = await doFetch(`${base}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "PayPal-Request-Id": randomUUID(),
        },
        body: "grant_type=client_credentials",
      });
      if (!res.ok) throw new Error(`PayPal OAuth failed (${res.status})`);
      const t = Token.parse(await res.json());
      cached = { token: t.access_token, exp: Date.now() + t.expires_in * 1000 };
      return t.access_token;
    })().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  return {
    async createOrder(body) {
      const res = await doFetch(`${base}/v2/checkout/orders`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await token()}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": randomUUID(),
          Prefer: "return=representation",
        },
        body: JSON.stringify(body),
      });
      const json: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const e = json as {
          name?: string;
          message?: string;
          debug_id?: string;
          details?: Array<{ issue?: string }>;
        };
        throw new Error(
          `PayPal create order failed (${res.status} ${e.name ?? ""} ${e.details?.[0]?.issue ?? ""}) debug_id=${e.debug_id ?? "?"}`,
        );
      }
      const order = CreatedOrder.parse(json);
      const approveUrl = order.links?.find(
        (l) => l.rel === "payer-action" || l.rel === "approve",
      )?.href;
      if (!approveUrl) throw new Error("PayPal returned no approval link");
      return { id: order.id, approveUrl };
    },
  };
}
