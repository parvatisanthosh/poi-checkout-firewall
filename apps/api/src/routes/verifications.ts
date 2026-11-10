import { Router } from "express";
import { DecisionRequest, VerificationResult, type SettlementAction } from "@poi/shared";
import { z } from "zod";
import type { AppDeps } from "../app";
import { sha256Canonical } from "../evidence/canonical";
import { appendEvidence } from "../evidence/chain";
import { HttpError } from "../lib/errors";
import { handle } from "../lib/handler";
import { parseChecks, toVerificationResult } from "../lib/mappers";
import { getAntibody, markFalseHits } from "../immune/antibody.repo";
import { computeFeatures } from "../immune/features";
import { familyFromCheck, familyFromReason, loadOrderEvidence } from "../immune/mint.job";
import { retire, shouldRetire } from "../immune/promote.job";
import { recordReport } from "../immune/risk";
import { topCheck } from "../verifier/lattice";

const IdParams = z.object({ id: z.string().min(1).max(64) });
type Deps = Pick<
  AppDeps,
  "prisma" | "paypal" | "signingKey" | "emitter" | "logger" | "enqueueMint"
>;

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
        // Layer 2 bookkeeping must never undo a settlement that already happened on PayPal.
        await learnFromDecision(deps, v, body.decision).catch((err: unknown) =>
          deps.logger.warn(
            { verificationId: v.id, err: (err as Error).message },
            "immune feedback failed",
          ),
        );
        const fresh = await db.verification.findUniqueOrThrow({ where: { id: v.id }, include });
        return toVerificationResult(fresh, o.intentId);
      },
    ),
  );

  return r;
}

/**
 * Immune feedback from a human decision (CONTRACTS-L2 5.2 "Retirement", Q4):
 *  - approved (CAPTURE): every antibody that escalated this order gets a false hit, and is retired
 *    at 2+ false hits with false hits / hits > 0.2 (a human-driven loosening, never automatic per order);
 *  - rejected (VOID) after ASK_HUMAN: counts as a report and the trick is minted.
 */
async function learnFromDecision(
  deps: Deps,
  v: { id: string; orderId: string; verdict: string | null; checks: unknown },
  decision: "CAPTURE" | "VOID",
) {
  const db = deps.prisma();
  if (decision === "CAPTURE") {
    for (const c of await markFalseHits(db, v.id)) {
      if (!shouldRetire(c)) continue;
      const a = await getAntibody(db, c.antibodyId);
      if (a?.status === "active")
        await retire(db, a.id, `auto: ${c.falseHits} false hits of ${c.hits}`);
    }
    return;
  }
  if (v.verdict !== "ASK_HUMAN") return;
  await recordReport(db, v.orderId);
  const top = topCheck(parseChecks(v.checks));
  let family = top ? familyFromCheck(top.check) : null;
  if (!family) {
    const ev = await loadOrderEvidence(db, v.orderId);
    if (ev) family = familyFromReason("", computeFeatures(ev, await db.merchant.findMany()));
  }
  if (family) await deps.enqueueMint({ orderId: v.orderId, family, source: "human-reject" });
}
