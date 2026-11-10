import { Router } from "express";
import {
  AttachOrderRequest,
  AuthorizeOrderResponse,
  OkResponse,
  VerifierConfig,
  VerifyOrderRequest,
  VerifyOrderResponse,
} from "@poi/shared";
import { z } from "zod";
import type { AppDeps } from "../app";
import { env } from "../env";
import { HttpError } from "../lib/errors";
import { handle } from "../lib/handler";
import { toDbMode } from "../lib/mappers";
import type { Prisma } from "../lib/prisma";

const OrderParams = z.object({ orderId: z.string().regex(/^[\w-]{1,64}$/, "invalid order id") });
const json = (v: unknown) => v as Prisma.InputJsonValue;

type Deps = Pick<AppDeps, "prisma" | "paypal" | "queue">;

export function ordersRouter(deps: Deps): Router {
  const r = Router();

  r.post(
    "/orders/:orderId/attach",
    handle(
      { params: OrderParams, body: AttachOrderRequest, response: OkResponse },
      async ({ params, body }) => {
        const db = deps.prisma();
        const intent = await db.intent.findUnique({ where: { id: body.intentId } });
        if (!intent)
          throw new HttpError(404, "INTENT_NOT_FOUND", `Intent ${body.intentId} not found`);
        if (intent.status !== "SIGNED")
          throw new HttpError(409, "INTENT_REVOKED", "Intent is revoked");

        const existing = await db.orderRecord.findUnique({
          where: { id: params.orderId },
          include: { verifications: { select: { id: true } } },
        });
        if (existing) {
          if (existing.intentId !== body.intentId)
            throw new HttpError(
              409,
              "ORDER_ALREADY_ATTACHED",
              "Order is attached to a different intent",
            );
          if (existing.verifications.length)
            throw new HttpError(409, "ORDER_ALREADY_VERIFIED", "Order already has a verification");
        }
        const data = {
          mode: toDbMode(body.mode),
          agentTrace: json(body.agentTrace),
          runTag: body.runTag ?? null,
        };
        await db.orderRecord.upsert({
          where: { id: params.orderId },
          create: {
            id: params.orderId,
            intentId: body.intentId,
            merchantId: "unknown",
            paypalStatus: "UNKNOWN",
            ...data,
          },
          update: data,
        });
        return { ok: true as const };
      },
    ),
  );

  // After the buyer approves: place the hold, then verify. Idempotent per order.
  r.post(
    "/orders/:orderId/authorize",
    handle({ params: OrderParams, response: AuthorizeOrderResponse }, async ({ params }) => {
      const db = deps.prisma();
      const order = await db.orderRecord.findUnique({
        where: { id: params.orderId },
        include: {
          verifications: { where: { mode: "LIVE" }, orderBy: { createdAt: "desc" }, take: 1 },
        },
      });
      if (!order)
        throw new HttpError(404, "ORDER_NOT_ATTACHED", "Attach the order to an intent first");
      if (order.mode !== "LIVE")
        throw new HttpError(
          409,
          "ORDER_IS_DRY_RUN",
          "Dry-run orders are verified with /verify, not authorized",
        );
      const prior = order.verifications[0];
      if (order.authorizationId && prior) {
        return { authorizationId: order.authorizationId, verificationId: prior.id };
      }
      if (!deps.paypal)
        throw new HttpError(503, "PAYPAL_NOT_CONFIGURED", "PayPal credentials are not configured");

      const { authorizationId, order: ppOrder } = await deps.paypal.authorizeOrder(params.orderId);
      await db.orderRecord.update({
        where: { id: order.id },
        data: { authorizationId, paypalStatus: "AUTHORIZED", rawOrder: json(ppOrder) },
      });
      const verification =
        prior ??
        (await db.verification.create({
          data: {
            orderId: order.id,
            mode: "LIVE",
            // LIVE_LAYER2: immune memory + conformal gate on live orders (Layer 1 only when off).
            config: json(
              VerifierConfig.parse(env.LIVE_LAYER2 ? { immune: true, conformal: true } : {}),
            ),
          },
        }));
      await deps.queue.enqueue(verification.id);
      return { authorizationId, verificationId: verification.id };
    }),
  );

  r.post(
    "/orders/:orderId/verify",
    handle(
      { params: OrderParams, body: VerifyOrderRequest, response: VerifyOrderResponse, status: 202 },
      async ({ params, body }) => {
        const db = deps.prisma();
        const order = await db.orderRecord.findUnique({ where: { id: params.orderId } });
        if (!order)
          throw new HttpError(404, "ORDER_NOT_ATTACHED", "Attach the order to an intent first");
        // Fail fast: retrying a job that can't read the order from PayPal is pointless.
        if (!deps.paypal)
          throw new HttpError(
            503,
            "PAYPAL_NOT_CONFIGURED",
            "PayPal credentials are not configured",
          );
        const verification = await db.verification.create({
          data: {
            orderId: order.id,
            mode: "DRY_RUN",
            config: json(VerifierConfig.parse(body.config ?? {})),
          },
        });
        await deps.queue.enqueue(verification.id);
        return { verificationId: verification.id };
      },
    ),
  );

  return r;
}
