// P7: one verification, end to end.
//   PayPal re-read -> normalize -> deterministic -> [terms RAG -> judge] || [shadow + injection]
//   -> lattice -> summary -> persist verdict -> settle (live) -> evidence -> events
// The verdict is persisted BEFORE money moves. A retry after a failed capture/void reuses the
// stored verdict instead of re-judging, so one hold can never get a VOID and then a CAPTURE.
import type { EmbeddingModel, LanguageModel } from "ai";
import {
  AgentTrace,
  IntentSpec,
  NormalizedOrder,
  VerifierConfig,
  type CheckResult,
  type ListingCard,
  type SettlementAction,
  type Verdict,
} from "@poi/shared";
import { sha256Canonical } from "../evidence/canonical";
import { appendEvidence } from "../evidence/chain";
import type { SigningKey } from "../evidence/keys";
import type { Logger } from "../lib/logger";
import { parseChecks } from "../lib/mappers";
import type { Prisma, PrismaClient } from "../lib/prisma";
import type { PayPal } from "../paypal";
import type { Emitter } from "../realtime/emitter";
import { runDeterministic } from "./deterministic";
import { checkInjection } from "./injection";
import { judgeOrder } from "./judge";
import { decideVerdict, topCheck } from "./lattice";
import { normalizeOrder, NormalizeError } from "./normalize";
import { runShadow } from "./shadow";
import { retrieveTerms, termsChecks, type TermsChunk } from "./terms-rag";

export interface PipelineDeps {
  prisma: () => PrismaClient;
  paypal?: PayPal;
  signingKey: () => Promise<SigningKey>;
  emitter: Emitter;
  logger: Logger;
  judgeModel?: LanguageModel;
  injectionModel?: LanguageModel;
  embeddingModel?: EmbeddingModel;
  /** The agent's own model for the shadow run (undefined when its key is missing). */
  agentModel: (id: string) => LanguageModel | undefined;
  listingCard?: (sku: string) => Promise<ListingCard | undefined>;
  /**
   * Arena only: terms an order's merchant publishes outside the ingested TermsChunk table (an
   * arena tenant's evolved termsExcerpt). Added to the retrieved chunks, never replacing them,
   * and run through the same checks, so it can only add evidence.
   */
  extraTerms?: (orderId: string) => TermsChunk[];
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/** One sentence from the verdict and the check that drives it. Template, no LLM. */
export function summarize(verdict: Verdict, checks: CheckResult[], live: boolean): string {
  const why = topCheck(checks)?.reason ?? "a check did not pass.";
  if (verdict === "CAPTURE")
    return `${live ? "Captured" : "Would capture"}: the order matches your intent.`;
  if (verdict === "VOID") return `${live ? "Voided" : "Would void"}: ${lowerFirst(why)}`;
  return `Needs your OK: ${lowerFirst(why)}`;
}

export function stagesFor(config: VerifierConfig): string[] {
  return [
    ...(config.deterministic ? ["deterministic"] : []),
    ...(config.terms ? ["rag"] : []),
    ...(config.semantic ? ["semantic"] : []),
    ...(config.shadow ? ["shadow"] : []),
  ];
}

export async function runVerification(deps: PipelineDeps, verificationId: string): Promise<void> {
  const db = deps.prisma();
  const v = await db.verification.findUnique({
    where: { id: verificationId },
    include: { order: { include: { intent: true } }, evidence: { select: { seq: true } } },
  });
  if (!v) throw new Error(`verification ${verificationId} not found`);
  if (v.status === "DONE") return; // duplicate delivery

  const order = v.order;
  const intent = order.intent;
  const spec = IntentSpec.parse(intent.spec);
  const live = v.mode === "LIVE";
  const t0 = performance.now();
  const base = { verificationId, orderId: order.id };

  let checks: CheckResult[];
  let verdict: Verdict;
  let summary: string;
  let rawOrder: unknown = order.rawOrder;
  let normalized: NormalizedOrder | null = order.normalized
    ? NormalizedOrder.parse(order.normalized)
    : null;

  if (v.verdict) {
    // Retry after the verdict was stored (e.g. capture failed): settle, don't re-judge.
    checks = parseChecks(v.checks);
    verdict = v.verdict;
    summary = v.summary ?? summarize(verdict, checks, live);
  } else {
    const config = VerifierConfig.parse(v.config);
    const trace = AgentTrace.parse(order.agentTrace);
    await db.verification.update({
      where: { id: verificationId },
      data: { status: "RUNNING", error: null },
    });
    deps.emitter.started({ ...base, stages: stagesFor(config) });

    checks = [];
    const emit = (c: CheckResult) => {
      checks.push(c);
      deps.emitter.check({ ...base, check: c });
    };

    if (!deps.paypal)
      throw new Error("PayPal is not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)");
    const paypalOrder = await deps.paypal.getOrder(order.id);
    rawOrder = paypalOrder;
    const registry = await db.merchant.findMany();

    try {
      normalized = normalizeOrder(paypalOrder);
    } catch (err) {
      if (!(err instanceof NormalizeError)) throw err;
      normalized = null;
      emit({
        check: "amount",
        stage: "deterministic",
        outcome: "fail",
        severity: "high",
        reason: `POI can't verify this order: ${err.message}.`,
        latencyMs: 0,
      });
    }
    await db.orderRecord.update({
      where: { id: order.id },
      data: {
        rawOrder: json(paypalOrder),
        ...(normalized ? { normalized: json(normalized), merchantId: normalized.merchantId } : {}),
        paypalStatus: paypalOrder.status,
      },
    });

    if (normalized) {
      const n = normalized;
      if (config.deterministic) runDeterministic(spec, n, registry).forEach(emit);

      const rag: Promise<TermsChunk[]> = config.terms
        ? (async () => {
            const s = performance.now();
            const retrieved = await retrieveTerms(db, n.merchantId, n, {
              embeddingModel: deps.embeddingModel,
            }).catch((err: unknown) => {
              deps.logger.warn({ err: (err as Error).message }, "terms retrieval failed");
              return [];
            });
            const chunks = [...(deps.extraTerms?.(order.id) ?? []), ...retrieved];
            termsChecks(
              chunks,
              Math.round(performance.now() - s),
              n,
              n.merchantDisplayName,
            ).forEach(emit);
            return chunks;
          })()
        : Promise.resolve([]);

      const semantic = config.semantic
        ? rag.then(async (terms) => {
            (await judgeOrder(spec, n, { model: deps.judgeModel, registry, terms })).forEach(emit);
          })
        : Promise.resolve();

      const shadow = config.shadow
        ? (async () => {
            const cards = new Map<string, ListingCard>();
            if (deps.listingCard) {
              await Promise.all(
                trace.observedListings.map(async (l) => {
                  const card = await deps.listingCard!(l.sku);
                  if (card) cards.set(l.sku, card);
                }),
              );
            }
            const chosenPages = trace.observedListings.filter((l) =>
              trace.chosenSkus.includes(l.sku),
            );
            const [s, inj] = await Promise.all([
              runShadow(spec, trace, { model: deps.agentModel(trace.model), cards, registry }),
              checkInjection(chosenPages, { model: deps.injectionModel }),
            ]);
            emit(s);
            inj.forEach(emit);
          })()
        : Promise.resolve();

      await Promise.all([rag, semantic, shadow]);
    }

    verdict = decideVerdict(checks);
    summary = summarize(verdict, checks, live);
    await db.verification.update({
      where: { id: verificationId },
      data: {
        checks: json(checks),
        verdict,
        summary,
        latencyMs: Math.round(performance.now() - t0),
      },
    });
  }

  deps.emitter.verdict({ ...base, verdict, summary });

  // --- settlement
  let action: SettlementAction = "NONE";
  let paypalStatus: string | undefined = (rawOrder as { status?: string } | null)?.status;
  if (live && order.authorizationId) {
    if (!deps.paypal) throw new Error("PayPal is not configured");
    if (verdict === "CAPTURE") {
      const cap = await deps.paypal.captureAuthorization(order.authorizationId);
      action = "CAPTURED";
      paypalStatus = cap.status;
      await db.orderRecord.update({
        where: { id: order.id },
        data: { captureId: cap.id, paypalStatus: "CAPTURED" },
      });
    } else if (verdict === "VOID") {
      const auth = await deps.paypal.voidAuthorization(order.authorizationId);
      action = "VOIDED";
      paypalStatus = auth.status;
      await db.orderRecord.update({ where: { id: order.id }, data: { paypalStatus: "VOIDED" } });
    } else {
      action = "PENDING_HUMAN";
    }
  }

  // --- evidence (once per verification verdict)
  if (v.evidence.length === 0) {
    await appendEvidence(db, await deps.signingKey(), {
      kind: "verification",
      verificationId,
      intentId: intent.id,
      specHash: intent.specHash,
      mandateJws: intent.jws,
      orderId: order.id,
      orderSnapshotHash: rawOrder ? sha256Canonical(rawOrder) : null,
      normalized,
      checks,
      verdict,
      settlement: { action, ...(paypalStatus ? { paypalStatus } : {}) },
      createdAt: new Date().toISOString(),
    });
  }

  await db.verification.update({
    where: { id: verificationId },
    data: {
      status: "DONE",
      settlement: action,
      paypalStatus: paypalStatus ?? null,
      latencyMs: v.latencyMs ?? Math.round(performance.now() - t0),
    },
  });
  if (action === "CAPTURED" || action === "VOIDED") {
    deps.emitter.settled({ orderId: order.id, action, paypalStatus: paypalStatus ?? action });
  }
}

/** After the last retry: record the failure. The PayPal hold is left alone (fail closed: never capture). */
export async function markVerificationFailed(
  deps: Pick<PipelineDeps, "prisma" | "logger">,
  verificationId: string,
  err: unknown,
) {
  const message = err instanceof Error ? err.message : String(err);
  deps.logger.error({ verificationId, err: message }, "verification failed");
  await deps
    .prisma()
    .verification.update({
      where: { id: verificationId },
      data: { status: "ERROR", error: message.slice(0, 500) },
    })
    .catch(() => {});
}
