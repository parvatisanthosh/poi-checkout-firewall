// immune.promote (CONTRACTS-L2 4.3, 5.2 "Promotion gate"): before a candidate goes live it is
// matched against all 40 benign listings (and their benign orders). Any hit rejects it; it must
// also match its own source order. Pass = ACTIVE and DefenderState.version += 1, in one
// transaction. This is the answer to "what if someone poisons the memory?": an antibody that
// would flag good purchases never goes live.
//
// The gate is stricter than live matching in one way: a short candidate whose text is mostly
// contained in a benign listing (estimated containment >= 0.8) is rejected even though its
// Jaccard is low -- that's how "great product, fast shipping"-style generic text is caught.
import type { EmbeddingModel } from "ai";
import type { ImmuneMatch } from "@poi/shared";
import type { Logger } from "../lib/logger";
import type { PrismaClient } from "../lib/prisma";
import type { ArenaEmitter } from "../realtime/arena-emitter";
import {
  activateAntibody,
  antibodyEmbedding,
  getAntibody,
  rejectCandidate,
  retireAntibody,
  shingleCountOf,
} from "./antibody.repo";
import { benignProbes } from "./benign";
import { bumpVersion, getDefender } from "./defender";
import { buildProbe, matchAntibody } from "./match";
import { loadOrderEvidence } from "./mint.job";

export const GATE_CONTAINMENT = 0.8;

export interface PromoteDeps {
  prisma: () => PrismaClient;
  embeddingModel?: EmbeddingModel;
  emitter: ArenaEmitter;
  logger: Logger;
  benignSetPath: string;
  thresholds: { jaccard: number; cosine: number };
}

export interface PromoteResult {
  antibodyId: string;
  outcome: "promoted" | "rejected" | "skipped";
  benignHits: Array<{ sku: string; kind: ImmuneMatch["kind"]; similarity: number }>;
  selfMatch: boolean;
  defenderVersion: number;
}

export async function promoteAntibody(
  deps: PromoteDeps,
  antibodyId: string,
): Promise<PromoteResult> {
  const db = deps.prisma();
  const a = await getAntibody(db, antibodyId);
  if (!a || a.status !== "candidate") {
    const v = (await getDefender(db)).version;
    return { antibodyId, outcome: "skipped", benignHits: [], selfMatch: false, defenderVersion: v };
  }
  const registry = await db.merchant.findMany();
  const [benign, emb, shingles] = await Promise.all([
    benignProbes(deps.benignSetPath, registry, deps.embeddingModel),
    antibodyEmbedding(db, a.id),
    shingleCountOf(db, a.id),
  ]);

  const gate = {
    ...deps.thresholds,
    ...(shingles > 0
      ? { containment: { threshold: GATE_CONTAINMENT, antibodyShingles: shingles } }
      : {}),
  };
  const benignHits = benign.flatMap((b) => {
    const m = matchAntibody(a, b.probe, gate, emb ? { antibodyEmbedding: emb } : {});
    return m ? [{ sku: b.sku, kind: m.kind, similarity: m.similarity }] : [];
  });

  const source = await loadOrderEvidence(db, a.sourceOrderId);
  const selfMatch = source
    ? matchAntibody(a, buildProbe(source, registry), deps.thresholds) !== null
    : false;

  if (benignHits.length === 0 && selfMatch) {
    const version = await bumpVersion(db, `promote antibody ${a.id}`, (tx, v) =>
      activateAntibody(tx, a.id, v),
    );
    deps.emitter.promoted({ antibodyId: a.id, falseHits: 0, defenderVersion: version });
    deps.logger.info({ antibodyId: a.id, version }, "immune.promote: ACTIVE");
    return {
      antibodyId: a.id,
      outcome: "promoted",
      benignHits,
      selfMatch,
      defenderVersion: version,
    };
  }

  await rejectCandidate(db, a.id);
  const version = (await getDefender(db)).version;
  deps.emitter.rejected({
    antibodyId: a.id,
    falseHits: benignHits.length,
    defenderVersion: version,
  });
  deps.logger.info(
    {
      antibodyId: a.id,
      selfMatch,
      benignHits: benignHits.slice(0, 5).map((h) => `${h.sku}:${h.kind}`),
    },
    "immune.promote: rejected",
  );
  return { antibodyId: a.id, outcome: "rejected", benignHits, selfMatch, defenderVersion: version };
}

/** Auto-retirement (5.2 "Retirement"): 2+ false hits and false hits / hits > 0.2. */
export const shouldRetire = (c: { hits: number; falseHits: number }) =>
  c.falseHits >= 2 && c.falseHits / Math.max(1, c.hits) > 0.2;

/** Retire an ACTIVE antibody, bumping the defender version. Returns the new version. */
export async function retire(db: PrismaClient, antibodyId: string, reason: string) {
  return bumpVersion(db, `retire antibody ${antibodyId}: ${reason}`, (tx, v) =>
    retireAntibody(tx, antibodyId, v),
  );
}
