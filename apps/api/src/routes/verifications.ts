import { Router } from "express";
import { DecisionRequest, VerificationResult, type SettlementAction } from "@poi/shared";
import { z } from "zod";
import type { AppDeps } from "../app";
import { sha256Canonical } from "../evidence/canonical";
import { appendEvidence } from "../evidence/chain";
import { HttpError } from "../lib/errors";
import { handle } from "../lib/handler";
import { parseChecks, toVerificationResult } from "../lib/mappers";

const IdParams = z.object({ id: z.string().min(1).max(64) });
type Deps = Pick<AppDeps, "prisma" | "paypal" | "signingKey" | "emitter">;

const include = {
  order: { select: { intentId: true } },
  evidence: { select: { hash: true, seq: true } },
} as const;

export function verificationsRouter(deps: Deps): Router {
  const r = Router();

  r.get(
    "/verifications/:id",
    handle({ params: IdParams, response: VerificationResult }, async ({ params }) => {
      const v = await deps.prisma().verification.findUnique({ where: { id: params.id }, include });
      if (!v)
        throw new HttpError(404, "VERIFICATION_NOT_FOUND", `Verification ${params.id} not found`);
      return toVerificationResult(v, v.order.intentId);
    }),
  );

  // The human's answer to ASK_HUMAN (or to a live verification that errored with the hold
  // still in place). Settles on PayPal and appends a decision record to the evidence chain.
  r.post(
    "/verifications/:id/decision",
    handle(
      { params: IdParams, body: DecisionRequest, response: VerificationResult },
      async ({ params, body }) => {
        const db = deps.prisma();
        const v = await db.verification.findUnique({
          where: { id: params.id },
          include: { order: { include: { intent: true } } },
        });
        if (!v)
          throw new HttpError(404, "VERIFICATION_NOT_FOUND", `Verification ${params.id} not found`);
        const awaiting =
          v.mode === "LIVE" && (v.settlement === "PENDING_HUMAN" || v.status === "ERROR");
        if (!awaiting || !v.order.authorizationId) {
          throw new HttpError(
            409,
            "NOT_AWAITING_DECISION",
            "This verification is not waiting for a human decision",
          );
        }
        if (!deps.paypal)
          throw new HttpError(
            503,
            "PAYPAL_NOT_CONFIGURED",
            "PayPal credentials are not configured",
          );

        let action: SettlementAction;
        let paypalStatus: string;
        if (body.decision === "CAPTURE") {
          const cap = await deps.paypal.captureAuthorization(v.order.authorizationId);
          action = "CAPTURED";
          paypalStatus = cap.status;
          await db.orderRecord.update({
            where: { id: v.orderId },
            data: { captureId: cap.id, paypalStatus: "CAPTURED" },
          });
        } else {
          const auth = await deps.paypal.voidAuthorization(v.order.authorizationId);
          action = "VOIDED";
          paypalStatus = auth.status;
          await db.orderRecord.update({
            where: { id: v.orderId },
            data: { paypalStatus: "VOIDED" },
          });
        }
        await db.verification.update({
          where: { id: v.id },
          data: { humanDecision: body.decision, settlement: action, paypalStatus, status: "DONE" },
        });
        const o = v.order;
        await appendEvidence(db, await deps.signingKey(), {
          kind: "decision",
          verificationId: v.id,
          intentId: o.intentId,
          specHash: o.intent.specHash,
          mandateJws: o.intent.jws,
          orderId: o.id,
          orderSnapshotHash: o.rawOrder ? sha256Canonical(o.rawOrder) : null,
          normalized: o.normalized,
          checks: parseChecks(v.checks),
          verdict: v.verdict,
          humanDecision: body.decision,
          settlement: { action, paypalStatus },
          createdAt: new Date().toISOString(),
        });
        deps.emitter.settled({ orderId: o.id, action, paypalStatus });
        const fresh = await db.verification.findUniqueOrThrow({ where: { id: v.id }, include });
        return toVerificationResult(fresh, o.intentId);
      },
    ),
  );

  return r;
}
