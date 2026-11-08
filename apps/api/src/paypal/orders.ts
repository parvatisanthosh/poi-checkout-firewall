import type { PayPalHttp } from "./http";
import { PayPalError } from "./errors";
import { paypalRequestId } from "./idempotency";
import { PayPalOrder, type CreateOrderBody, type PayPalAuthorization } from "./schemas";

export interface AuthorizeResult {
  authorizationId: string;
  authorization: PayPalAuthorization;
  order: PayPalOrder;
}

const orderPath = (id: string) => `/v2/checkout/orders/${encodeURIComponent(id)}`;

function firstAuthorization(order: PayPalOrder): PayPalAuthorization | undefined {
  return order.purchase_units[0]?.payments?.authorizations?.[0];
}

export function createOrdersApi(http: PayPalHttp) {
  async function getOrder(orderId: string): Promise<PayPalOrder> {
    return http.get({
      path: orderPath(orderId),
      schema: PayPalOrder,
      what: `GET order ${orderId}`,
    });
  }

  /**
   * POST /v2/checkout/orders/{id}/authorize: places the hold. The authorization id comes from
   * purchase_units[0].payments.authorizations[0].
   *
   * If PayPal rejects the call (422) because the order was already authorized -- e.g. by a
   * previous attempt whose response we never received -- we re-read the order and return the
   * existing authorization instead of failing. Any other 422 is rethrown.
   */
  async function authorizeOrder(orderId: string): Promise<AuthorizeResult> {
    const what = `authorize order ${orderId}`;
    let order: PayPalOrder | undefined;
    try {
      order = await http.post({
        path: `${orderPath(orderId)}/authorize`,
        body: {},
        requestId: paypalRequestId("authorize", orderId),
        schema: PayPalOrder,
        what,
      });
    } catch (err) {
      if (!(err instanceof PayPalError && err.status === 422)) throw err;
      const current = await getOrder(orderId);
      if (!firstAuthorization(current)) throw err;
      order = current;
    }
    order ??= await getOrder(orderId);
    const authorization = firstAuthorization(order);
    if (!authorization) {
      throw new PayPalError(
        0,
        "POI_NO_AUTHORIZATION",
        `${what}: PayPal returned no authorization in purchase_units[0].payments`,
      );
    }
    return { authorizationId: authorization.id, authorization, order };
  }

  /** POST /v2/checkout/orders (as a merchant). Used by the smoke script; the Bazaar has its own. */
  async function createOrder(
    body: CreateOrderBody,
    opts: { reference: string },
  ): Promise<PayPalOrder> {
    const order = await http.post({
      path: "/v2/checkout/orders",
      body,
      requestId: paypalRequestId("create", opts.reference),
      schema: PayPalOrder,
      what: "create order",
    });
    if (!order)
      throw new PayPalError(0, "POI_INVALID_PAYPAL_RESPONSE", "create order: empty response");
    return order;
  }

  return { getOrder, authorizeOrder, createOrder };
}

/** The buyer approval URL ("payer-action" with payment_source, "approve" without). */
export function approvalLink(order: PayPalOrder): string | undefined {
  return order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
}
