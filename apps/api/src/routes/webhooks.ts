// P10: POST /api/webhooks/paypal. Each delivery is verified with PayPal, processed once (event
// id stored in the same transaction as the update), and can only move an order's status forward.
import { Router, type Request } from "express";
import { z } from "zod";
import type { AppDeps } from "../app";
import { HttpError } from "../lib/errors";
import { WEBHOOK_HEADERS } from "../paypal";

const WebhookEvent = z.looseObject({
  id: z.string().min(1),
  event_type: z.string(),
  resource: z.looseObject({
    id: z.string().optional(),
    status: z.string().optional(),
    supplementary_data: z
      .looseObject({
        related_ids: z
          .looseObject({ order_id: z.string().optional(), authorization_id: z.string().optional() })
          .optional(),
      })
      .optional(),
  }),
});

// Status only moves forward: a late APPROVED must not overwrite CAPTURED.
const RANK: Record<string, number> = {
  UNKNOWN: 0,
  CREATED: 1,
  PAYER_ACTION_REQUIRED: 1,
  APPROVED: 2,
  AUTHORIZED: 3,
  VOIDED: 4,
  CAPTURED: 4,
  COMPLETED: 4,
};
const rank = (s: string) => RANK[s] ?? 0;

const HANDLED: Record<string, string> = {
  "CHECKOUT.ORDER.APPROVED": "APPROVED",
  "PAYMENT.AUTHORIZATION.CREATED": "AUTHORIZED",
  "PAYMENT.AUTHORIZATION.VOIDED": "VOIDED",
  "PAYMENT.CAPTURE.COMPLETED": "CAPTURED",
};

export interface RawBodyRequest extends Request {
  rawBody?: string;
}

type Deps = Pick<AppDeps, "prisma" | "paypal" | "emitter" | "webhookId">;

export function webhooksRouter(deps: Deps): Router {
  const r = Router();
  r.post("/webhooks/paypal", async (req: RawBodyRequest, res) => {
    const webhookId = deps.webhookId;
    if (!deps.paypal || !webhookId) {
      throw new HttpError(
        503,
        "WEBHOOKS_NOT_CONFIGURED",
        "PAYPAL_WEBHOOK_ID and PayPal credentials are required",
      );
    }
    const headers = Object.fromEntries(Object.values(WEBHOOK_HEADERS).map((h) => [h, req.get(h)]));
    const genuine = req.rawBody
      ? await deps.paypal.verifyWebhookSignature(headers, req.rawBody, webhookId)
      : false;
    if (!genuine)
      throw new HttpError(400, "WEBHOOK_SIGNATURE_INVALID", "PayPal did not verify this webhook");

    const event = WebhookEvent.parse(req.body);
    const status = HANDLED[event.event_type];
    const db = deps.prisma();
    const related = event.resource.supplementary_data?.related_ids;

    const outcome = await db.$transaction(async (tx) => {
      const seen = await tx.processedWebhookEvent.findUnique({ where: { id: event.id } });
      if (seen) return { duplicate: true as const };
      await tx.processedWebhookEvent.create({ data: { id: event.id, type: event.event_type } });
      if (!status) return { duplicate: false as const };

      const orderId =
        event.event_type === "CHECKOUT.ORDER.APPROVED" ? event.resource.id : related?.order_id;
      const authId = event.event_type.startsWith("PAYMENT.AUTHORIZATION")
        ? event.resource.id
        : related?.authorization_id;
      const order = orderId
        ? await tx.orderRecord.findUnique({ where: { id: orderId } })
        : authId
          ? await tx.orderRecord.findFirst({ where: { authorizationId: authId } })
          : null;
      if (!order || rank(status) <= rank(order.paypalStatus)) return { duplicate: false as const };
      await tx.orderRecord.update({
        where: { id: order.id },
        data: {
          paypalStatus: status,
          ...(status === "CAPTURED" && event.resource.id ? { captureId: event.resource.id } : {}),
        },
      });
      return { duplicate: false as const, orderId: order.id, status };
    });

    if ("status" in outcome && (outcome.status === "VOIDED" || outcome.status === "CAPTURED")) {
      deps.emitter.settled({
        orderId: outcome.orderId!,
        action: outcome.status,
        paypalStatus: event.resource.status ?? outcome.status,
      });
    }
    res.json({ ok: true, duplicate: outcome.duplicate });
  });
  return r;
}
