// P10: PayPal webhook verification (POST /v1/notifications/verify-webhook-signature).
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RawJson, type PayPalHttp } from "./http";

export const WEBHOOK_HEADERS = {
  authAlgo: "paypal-auth-algo",
  certUrl: "paypal-cert-url",
  transmissionId: "paypal-transmission-id",
  transmissionSig: "paypal-transmission-sig",
  transmissionTime: "paypal-transmission-time",
} as const;

const VerifyResponse = z.looseObject({ verification_status: z.string() });

export function createWebhooksApi(http: PayPalHttp) {
  /**
   * Asks PayPal whether this delivery is genuine. `rawEvent` is the exact request body: PayPal
   * verifies over the original bytes, so we splice it in rather than re-serializing.
   */
  async function verifyWebhookSignature(
    headers: Record<string, string | undefined>,
    rawEvent: string,
    webhookId: string,
  ): Promise<boolean> {
    const h = WEBHOOK_HEADERS;
    const fields = {
      auth_algo: headers[h.authAlgo],
      cert_url: headers[h.certUrl],
      transmission_id: headers[h.transmissionId],
      transmission_sig: headers[h.transmissionSig],
      transmission_time: headers[h.transmissionTime],
      webhook_id: webhookId,
    };
    if (Object.values(fields).some((v) => !v)) return false;
    const body = `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${rawEvent}}`;
    const res = await http.post({
      path: "/v1/notifications/verify-webhook-signature",
      body: new RawJson(body),
      // Verification is read-only on PayPal's side; a fresh id per call is correct.
      requestId: randomUUID(),
      schema: VerifyResponse,
      what: "verify webhook signature",
    });
    return res?.verification_status === "SUCCESS";
  }
  return { verifyWebhookSignature };
}
