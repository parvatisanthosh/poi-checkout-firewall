import type { PayPalHttp } from "./http";
import { PayPalError } from "./errors";
import { paypalRequestId } from "./idempotency";
import { PayPalAuthorization, PayPalCapture } from "./schemas";

const authPath = (id: string) => `/v2/payments/authorizations/${encodeURIComponent(id)}`;

export function createPaymentsApi(http: PayPalHttp) {
  async function getAuthorization(authorizationId: string): Promise<PayPalAuthorization> {
    return http.get({
      path: authPath(authorizationId),
      schema: PayPalAuthorization,
      what: `GET authorization ${authorizationId}`,
    });
  }

  /** Moves the money. final_capture: true releases any remainder of the hold. */
  async function captureAuthorization(authorizationId: string): Promise<PayPalCapture> {
    const what = `capture authorization ${authorizationId}`;
    const capture = await http.post({
      path: `${authPath(authorizationId)}/capture`,
      body: { final_capture: true },
      requestId: paypalRequestId("capture", authorizationId),
      schema: PayPalCapture,
      what,
    });
    if (!capture)
      throw new PayPalError(0, "POI_INVALID_PAYPAL_RESPONSE", `${what}: empty response`);
    return capture;
  }

  /**
   * Releases the hold, free of charge. PayPal may answer 204 with no body; then we read the
   * authorization back. A 422 on an authorization that is already VOIDED counts as success
   * (an earlier attempt landed), so voiding is safe to repeat.
   */
  async function voidAuthorization(authorizationId: string): Promise<PayPalAuthorization> {
    try {
      const auth = await http.post({
        path: `${authPath(authorizationId)}/void`,
        body: {},
        requestId: paypalRequestId("void", authorizationId),
        schema: PayPalAuthorization,
        what: `void authorization ${authorizationId}`,
      });
      return auth ?? (await getAuthorization(authorizationId));
    } catch (err) {
      if (!(err instanceof PayPalError && err.status === 422)) throw err;
      const current = await getAuthorization(authorizationId);
      if (current.status !== "VOIDED") throw err;
      return current;
    }
  }

  return { getAuthorization, captureAuthorization, voidAuthorization };
}
