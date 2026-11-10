// immune.mint (CONTRACTS-L2 4.3, 5.2 "Minting"): a reported order becomes a compact, signed,
// searchable CANDIDATE antibody -- unless an ACTIVE antibody already covers it (estimated Jaccard
// >= 0.8), in which case the report is absorbed and memory stays small. Then immune.promote.
import type { EmbeddingModel } from "ai";
import { AgentTrace, NormalizedOrder, type AttackFamily, type Merchant } from "@poi/shared";
import type { SigningKey } from "../evidence/keys";
import type { Logger } from "../lib/logger";
import type { PrismaClient } from "../lib/prisma";
import type { ArenaEmitter } from "../realtime/arena-emitter";
import { antibodyForSourceOrder, candidatesByBands, insertCandidate } from "./antibody.repo";
import { getDefender } from "./defender";
import { antibodyAction, chosenPageText, type Features, type OrderEvidence } from "./features";
import { estimatedJaccard } from "./lsh";
import { buildProbe, embedText, type Probe } from "./match";
import { signAntibody } from "./sign";

/** Merge into an existing ACTIVE antibody at or above this estimated Jaccard. */
export const MERGE_JACCARD = 0.8;

export type MintSource = "arena-oracle" | "report" | "live-void" | "human-reject";

export interface MintJob {
  orderId: string;
  family: AttackFamily;
  source: MintSource;
  /** Terms the order was subject to outside TermsChunk (an arena tenant's evolved excerpt). */
  termsText?: string;
}

export interface ImmuneJobDeps {
  prisma: () => PrismaClient;
  signingKey: () => Promise<SigningKey>;
  embeddingModel?: EmbeddingModel;
  emitter: ArenaEmitter;
  logger: Logger;
  enqueuePromote: (antibodyId: string) => Promise<void>;
}

/** The evidence for an order that has been verified at least once (it has a normalized snapshot). */
export async function loadOrderEvidence(
  db: PrismaClient,
  orderId: string,
  termsText?: string,
): Promise<OrderEvidence | null> {
  const o = await db.orderRecord.findUnique({
    where: { id: orderId },
    select: { normalized: true, agentTrace: true },
  });
  if (!o?.normalized) return null;
  const order = NormalizedOrder.parse(o.normalized);
  const trace = AgentTrace.safeParse(o.agentTrace);
  return {
    order,
    pageText: trace.success ? chosenPageText(trace.data) : "",
    ...(termsText ? { termsText } : {}),
  };
}

/** An ACTIVE antibody that already covers this probe (estimated Jaccard >= MERGE_JACCARD). */
export async function findMergeTarget(db: PrismaClient, probe: Probe): Promise<string | null> {
  const best = (await candidatesByBands(db, probe.minhash))
    .map((a) => ({ id: a.id, j: estimatedJaccard(a.minhash, probe.minhash) }))
    .filter((x) => x.j >= MERGE_JACCARD)
    .sort((a, b) => b.j - a.j)[0];
  return best?.id ?? null;
}

export interface MintResult {
  antibodyId: string;
  /** "created" a new candidate, "merged" into an active one, or "exists" (already minted). */
  outcome: "created" | "merged" | "exists";
}

export async function mintAntibody(deps: ImmuneJobDeps, job: MintJob): Promise<MintResult | null> {
  const db = deps.prisma();
  const existing = await antibodyForSourceOrder(db, job.orderId);
  if (existing) return { antibodyId: existing.id, outcome: "exists" };

  const ev = await loadOrderEvidence(db, job.orderId, job.termsText);
  if (!ev) {
    deps.logger.warn({ orderId: job.orderId }, "immune.mint: order has no verified snapshot");
    return null;
  }
  const registry: Merchant[] = await db.merchant.findMany();
  const probe = buildProbe(ev, registry);

  const mergeInto = await findMergeTarget(db, probe);
  if (mergeInto) {
    deps.logger.info({ orderId: job.orderId, antibodyId: mergeInto }, "immune.mint: merged");
    return { antibodyId: mergeInto, outcome: "merged" };
  }

  const features: Features = probe.features;
  const claims = {
    family: job.family,
    sourceOrderId: job.orderId,
    minhash: probe.minhash,
    features,
    skeleton: probe.skeleton,
    action: antibodyAction(job.family, features, probe.skeleton),
  };
  const [signature, embedding, defender] = await Promise.all([
    deps.signingKey().then((k) => signAntibody(k, claims)),
    embedText(deps.embeddingModel, probe.text).catch((err: unknown) => {
      deps.logger.warn({ err: (err as Error).message }, "immune.mint: embedding failed");
      return undefined;
    }),
    getDefender(db),
  ]);
  const a = await insertCandidate(
    db,
    { ...claims, defenderVersion: defender.version, signature, shingleCount: probe.shingleCount },
    embedding,
  );
  deps.emitter.minted({ antibodyId: a.id, family: a.family, sourceOrderId: job.orderId });
  deps.logger.info(
    { antibodyId: a.id, family: a.family, source: job.source, action: a.action },
    "immune.mint: candidate",
  );
  await deps.enqueuePromote(a.id);
  return { antibodyId: a.id, outcome: "created" };
}

// --- reason -> family (POST /immune/report, human rejects) -----------------------------------

const REASONS: Array<[RegExp, AttackFamily]> = [
  [/\bterms?\b|\bfine print\b|\btos\b/i, "tosrenew"],
  [/subscri|renew|recurr|monthly|membership|trial/i, "subscription"],
  [/add-?on|warranty|protection|insurance|extra item|didn'?t add/i, "addon"],
  [/\bfees?\b|surcharge|handling|service charge/i, "dripfee"],
  [/fake|look-?alike|impostor|wrong seller|not the real|counterfeit/i, "lookalike"],
  [/refurb|renewed|used|open[- ]box|wrong (?:model|version|variant)|variant/i, "variant"],
  [/instruction|prompt|injection|manipulat|hidden text|\bai\b|agent/i, "injection"],
];

/**
 * The family a human's reason names; otherwise the order's own structural evidence decides.
 * Returns null when nothing says what kind of trick it was (nothing to mint).
 */
export function familyFromReason(reason: string, features: Features): AttackFamily | null {
  for (const [re, family] of REASONS) if (re.test(reason)) return family;
  if (features.recurrence_in_checkout) return "subscription";
  if (features.recurrence_in_terms) return "tosrenew";
  if (features.digital_extra_line) return "addon";
  if (features.fee_lines) return "dripfee";
  if (features.condition_not_new) return "variant";
  if (features.addresses_ai || features.hidden_text_present) return "injection";
  if (features.seller_unverified) return "lookalike";
  return null;
}

/** The family a failing Layer 1 check points to (live VOIDs, human rejects), or null. */
export function familyFromCheck(check: string): AttackFamily | null {
  switch (check) {
    case "recurrence":
      return "subscription";
    case "addons":
      return "addon";
    case "condition":
      return "variant";
    case "lookalike":
    case "merchant":
      return "lookalike";
    case "terms":
      return "tosrenew";
    case "injection":
      return "injection";
    default:
      return null;
  }
}
