import { Router } from "express";
import {
  AgentTrace,
  IntentMandate,
  IntentSpec,
  LedgerQuery,
  LedgerResponse,
  NormalizedOrder,
  VerifyRecordResponseL2,
  type LedgerRow,
} from "@poi/shared";
import { z } from "zod";
import type { AppDeps } from "../app";
import { validateChain, verifyEvidenceJws } from "../evidence/chain";
import { HttpError } from "../lib/errors";
import { handle } from "../lib/handler";
import { fromDbMode, parseChecks, toDbMode, toVerificationResult } from "../lib/mappers";
import { verifyIntentJws } from "../intent/sign";
import { topCheck } from "../verifier/lattice";
import { getAntibodySummaries } from "../immune/antibody.repo";
import type { L2Record } from "../immune/layer2";

type Deps = Pick<AppDeps, "prisma" | "signingKey">;

// Cursor = base64url("<createdAt ISO>|<orderId>"), newest first.
const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const createdAt = new Date(iso ?? "");
  if (!id || Number.isNaN(createdAt.getTime()))
    throw new HttpError(400, "INVALID_CURSOR", "Invalid cursor");
  return { createdAt, id };
}

export function ledgerRouter(deps: Deps): Router {
  const r = Router();

  r.get(
    "/ledger",
    handle({ query: LedgerQuery, response: LedgerResponse }, async ({ query }) => {
      const after = query.cursor ? decodeCursor(query.cursor) : undefined;
      const rows = await deps.prisma().orderRecord.findMany({
        where: {
          ...(query.mode ? { mode: toDbMode(query.mode) } : {}),
          ...(after
            ? {
                OR: [
                  { createdAt: { lt: after.createdAt } },
                  { createdAt: after.createdAt, id: { lt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        include: { verifications: { orderBy: { createdAt: "desc" }, take: 1 } },
      });
      const page = rows.slice(0, query.limit);
      return {
        rows: page.map((o): LedgerRow => {
          const v = o.verifications[0];
          const n = NormalizedOrder.safeParse(o.normalized);
          const trace = AgentTrace.safeParse(o.agentTrace);
          const top = v ? topCheck(parseChecks(v.checks)) : undefined;
          // A CAPTURE row only shows a reason that mattered (not "shadow run skipped").
          const showTop = top && !(v?.verdict === "CAPTURE" && top.severity === "low");
          return {
            orderId: o.id,
            createdAt: o.createdAt.toISOString(),
            mode: fromDbMode(o.mode),
            ...(trace.success ? { model: trace.data.model } : {}),
            merchantDisplayName: n.success ? n.data.merchantDisplayName : o.merchantId,
            total: n.success ? n.data.total : { currency: "USD", value: "0.00" },
            ...(v?.verdict ? { verdict: v.verdict } : {}),
            ...(showTop ? { topReason: top.reason } : {}),
            settlement: v?.settlement ?? "NONE",
            ...(o.runTag ? { runTag: o.runTag } : {}),
          };
        }),
        nextCursor:
          rows.length > query.limit ? encodeCursor(page.at(-1)!.createdAt, page.at(-1)!.id) : null,
      };
    }),
  );

  // Everything a judge needs to check one order independently.
  r.get(
    "/verify/:orderId",
    handle(
      {
        params: z.object({ orderId: z.string().min(1).max(64) }),
        response: VerifyRecordResponseL2,
      },
      async ({ params }) => {
        const db = deps.prisma();
        const key = await deps.signingKey();
        const o = await db.orderRecord.findUnique({
          where: { id: params.orderId },
          include: {
            intent: true,
            verifications: {
              orderBy: { createdAt: "desc" },
              take: 1,
              include: { evidence: { orderBy: { seq: "desc" } } },
            },
          },
        });
        if (!o) throw new HttpError(404, "ORDER_NOT_FOUND", `Order ${params.orderId} not found`);
        const v = o.verifications[0];
        const ev = v?.evidence[0];
        const chain = await validateChain(db, key.publicKey, ev?.seq);
        const intentSigOk = await verifyIntentJws(o.intent.jws, key.publicKey)
          .then((p) => p.intentId === o.intent.id && p.specHash === o.intent.specHash)
          .catch(() => false);
        const n = NormalizedOrder.safeParse(o.normalized);
        IntentMandate.parse(o.intent.mandate);
        return {
          intent: {
            intentId: o.intent.id,
            rawText: o.intent.rawText,
            spec: IntentSpec.parse(o.intent.spec),
            specHash: o.intent.specHash,
            status: o.intent.status,
            createdAt: o.intent.createdAt.toISOString(),
          },
          order: n.success ? n.data : null,
          verification: v ? toVerificationResult(v, o.intentId) : null,
          evidence: ev
            ? {
                seq: ev.seq,
                prevHash: ev.prevHash,
                hash: ev.hash,
                payload: ev.payload,
                jws: ev.jws,
                createdAt: ev.createdAt.toISOString(),
              }
            : null,
          chainValid: ev ? chain.chainValid : false,
          // This order's signatures: the intent JWS and its latest evidence record's JWS.
          signatureValid: intentSigOk && (ev ? await verifyEvidenceJws(ev, key.publicKey) : true),
          publicJwk: key.publicJwk,
          ...(await layer2Fields(db, v?.l2 as L2Record | null | undefined)),
        };
      },
    ),
  );

  return r;
}

/**
 * The Layer 2 part of GET /verify/:orderId (CONTRACTS-L2 4.4): absent for Layer 1 verifications.
 * Antibody summaries are read fresh (current hits / status); everything else is as decided.
 */
async function layer2Fields(db: ReturnType<AppDeps["prisma"]>, l2: L2Record | null | undefined) {
  if (!l2) return {};
  const ids = (l2.immuneMatches ?? []).map((m) => m.antibodyId);
  return {
    ...(l2.immuneMatches ? { immuneMatches: l2.immuneMatches } : {}),
    ...(l2.immuneMatches ? { antibodies: await getAntibodySummaries(db, [...new Set(ids)]) } : {}),
    ...(l2.merchantRisk !== undefined ? { merchantRisk: l2.merchantRisk } : {}),
    ...(l2.calibration !== undefined ? { calibration: l2.calibration } : {}),
    ...(l2.defenderVersion !== undefined ? { defenderVersion: l2.defenderVersion } : {}),
    ...(l2.counterfactual !== undefined ? { counterfactual: l2.counterfactual } : {}),
  };
}
