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
import { decideVerdict, maxVerdict, topCheck } from "./lattice";
import { normalizeOrder, NormalizeError } from "./normalize";
import { runShadow } from "./shadow";
import { retrieveTerms, termsChecks, type TermsChunk } from "./terms-rag";
import { env } from "../env";
import { recordHits } from "../immune/antibody.repo";
import { computeCounterfactual } from "../immune/counterfactual";
import { gateSummary, runLayer2, type L2Record, type L2Thresholds } from "../immune/layer2";
import { familyFromCheck, type MintJob } from "../immune/mint.job";
import { bumpRisk, riskKey } from "../immune/risk";

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
  /** Layer 2 match thresholds; defaults from env (IMMUNE_JACCARD, IMMUNE_COSINE, RISK_ASK_THRESHOLD). */
  l2Thresholds?: L2Thresholds;
  /** immune.mint: a live VOID with a recognisable trick feeds immune memory. */
  enqueueMint?: (job: MintJob) => Promise<void>;
}

const defaultL2Thresholds = (): L2Thresholds => ({
  jaccard: env.IMMUNE_JACCARD,
  cosine: env.IMMUNE_COSINE,
  riskAsk: env.RISK_ASK_THRESHOLD,
});

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

export interface RunOptions {
  /**
   * Reuse the Layer 1 checks of this finished verification of the same order instead of re-reading
   * PayPal and re-running every stage (the arena's immune arm: both arms then judge the same Layer 1
   * result, so the immune verdict can only be the static one or stricter, and the LLM work is done once).
   */
  layer1From?: string;
}

/** The Layer 1 checks of a finished verification of the same order (Layer 2 checks left out). */
async function sharedLayer1(
  db: PrismaClient,
  fromId: string,
  orderId: string,
): Promise<CheckResult[]> {
  const from = await db.verification.findUnique({ where: { id: fromId } });
  if (!from || from.orderId !== orderId || from.status !== "DONE")
    throw new Error(`layer1From ${fromId}: not a finished verification of order ${orderId}`);
  return parseChecks(from.checks).filter((c) => c.check !== "immune" && c.check !== "risk");
}

export async function runVerification(
  deps: PipelineDeps,
  verificationId: string,
  opts: RunOptions = {},
): Promise<void> {
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
  let l2: L2Record | null = (v.l2 as L2Record | null) ?? null;
  let l2Matches: Awaited<ReturnType<typeof runLayer2>>["matches"] = [];
  const extraTermsText = (deps.extraTerms?.(order.id) ?? []).map((c) => c.text).join("\n");

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

    const registry = await db.merchant.findMany();
    const shared = opts.layer1From ? await sharedLayer1(db, opts.layer1From, order.id) : null;
    if (shared) {
      // Same order, judged moments ago: its snapshot is already on the order row.
      shared.forEach(emit);
    } else {
      if (!deps.paypal)
        throw new Error("PayPal is not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)");
      const paypalOrder = await deps.paypal.getOrder(order.id);
      rawOrder = paypalOrder;

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
          ...(normalized
            ? { normalized: json(normalized), merchantId: normalized.merchantId }
            : {}),
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
              (await judgeOrder(spec, n, { model: deps.judgeModel, registry, terms })).forEach(
                emit,
              );
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
    }

    // Layer 2: immune memory, merchant risk, conformal gate. Only adds checks / raises.
    if (normalized && (config.immune || config.conformal)) {
      const out = await runLayer2(db, {
        config,
        order: normalized,
        trace,
        mode: v.mode,
        ...(extraTermsText ? { termsText: extraTermsText } : {}),
        registry,
        checks,
        emit,
        thresholds: deps.l2Thresholds ?? defaultL2Thresholds(),
        embeddingModel: deps.embeddingModel,
      });
      l2 = out.record;
      l2Matches = out.matches;
      if (shared) l2.layer1From = opts.layer1From;
    }

    const checksVerdict = decideVerdict(checks);
    verdict = maxVerdict(checksVerdict, l2?.gate?.verdict ?? "CAPTURE");
    summary =
      l2 && verdict !== checksVerdict
        ? gateSummary(verdict, l2, live)
        : summarize(verdict, checks, live);
    if (l2 && normalized) {
      l2.counterfactual =
        verdict === "CAPTURE"
          ? null
          : computeCounterfactual(normalized, extraTermsText || undefined);
    }
    await db.verification.update({
      where: { id: verificationId },
      data: {
        checks: json(checks),
        verdict,
        summary,
        ...(l2 ? { l2: json(l2) } : {}),
        latencyMs: Math.round(performance.now() - t0),
      },
    });
    if (l2Matches.length) {
      const layer1 = l2?.layer1Verdict ?? "CAPTURE";
      const RANK = { CAPTURE: 0, ASK_HUMAN: 1, VOID: 2 } as const;
      await recordHits(
        db,
        l2Matches.map((m) => ({
          antibodyId: m.antibodyId,
          orderId: order.id,
          verificationId,
          kind: m.kind,
          similarity: m.similarity,
          live,
          escalated: RANK[m.action] > RANK[layer1],
        })),
      );
    }
    // Merchant risk: every order counts once (its first verification), under its live or arena key.
    if (normalized) {
      const done = await db.verification.count({ where: { orderId: order.id, status: "DONE" } });
      if (done === 0) await bumpRisk(db, riskKey(normalized.merchantId, v.mode), "orders");
    }
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
      await afterLiveVoid(deps, order.id, normalized?.merchantId ?? order.merchantId, checks);
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
      // Layer 2 fields appear only in records of Layer 2 verifications (older records unchanged).
      ...(l2 ? { layer2: evidenceL2(l2) } : {}),
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

/**
 * The signed Layer 2 part of an evidence record: matches, risk, calibration, defender version,
 * counterfactual, the Layer 1 verdict and the gate. Antibodies are referenced by id + signature
 * (their counters change later; their signed claims don't).
 */
function evidenceL2(l2: L2Record) {
  const { antibodies, ...rest } = l2;
  return {
    ...rest,
    ...(antibodies
      ? { antibodies: antibodies.map((a) => ({ id: a.id, signature: a.signature })) }
      : {}),
  };
}

/** A live VOID: the seller's risk goes up, and a recognisable trick is minted into immune memory. */
async function afterLiveVoid(
  deps: PipelineDeps,
  orderId: string,
  merchantId: string,
  checks: CheckResult[],
): Promise<void> {
  const db = deps.prisma();
  await bumpRisk(db, riskKey(merchantId, "LIVE"), "voids");
  const top = topCheck(checks);
  const family = top ? familyFromCheck(top.check) : null;
  if (family && deps.enqueueMint) {
    await deps
      .enqueueMint({ orderId, family, source: "live-void" })
      .catch((err: unknown) =>
        deps.logger.warn({ orderId, err: (err as Error).message }, "immune.mint enqueue failed"),
      );
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
