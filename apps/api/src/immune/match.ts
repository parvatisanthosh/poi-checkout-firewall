// Matching an order against antibodies (CONTRACTS-L2 5.2 steps 5-6). One "probe" per order holds
// everything the four matchers need; matchAntibody decides one antibody, and the verifier stage,
// the promotion gate and the gate's self-check all call it, so they can't disagree.
//   minhash   estimated Jaccard >= IMMUNE_JACCARD           text evidence   -> ASK_HUMAN
//   embedding cosine >= IMMUNE_COSINE                         text evidence   -> ASK_HUMAN
//   features  antibody's true flags (>= 2) subset of order's  structural      -> antibody.action
//   skeleton  same confusables skeleton, unverified seller    structural      -> antibody.action
import { embed, type EmbeddingModel } from "ai";
import type { Antibody, ImmuneMatch, Merchant } from "@poi/shared";
import { EMBEDDING_DIMS } from "@poi/shared/llm";
import { estimatedContainment, fingerprint } from "./fingerprint";
import {
  computeFeatures,
  evidenceText,
  featureMatch,
  sellerSkeleton,
  type Features,
  type OrderEvidence,
} from "./features";
import { estimatedJaccard } from "./lsh";

export interface Probe {
  text: string;
  minhash: number[];
  shingleCount: number;
  features: Features;
  /** The order seller's skeleton when the seller is unverified, else null. */
  skeleton: string | null;
  embedding?: number[];
}

export interface MatchThresholds {
  jaccard: number;
  cosine: number;
  /**
   * Promotion gate only: also match when the antibody's text is mostly contained in the probe's
   * (estimated containment >= this). Needs the antibody's shingle count.
   */
  containment?: { threshold: number; antibodyShingles: number };
}

/** Embed text for a probe or an antibody; undefined without a model or on a dimension mismatch. */
export async function embedText(
  model: EmbeddingModel | undefined,
  text: string,
): Promise<number[] | undefined> {
  if (!model || !text) return undefined;
  const { embedding } = await embed({ model, value: text.slice(0, 8000) });
  return embedding.length === EMBEDDING_DIMS ? embedding : undefined;
}

export function buildProbe(ev: OrderEvidence, registry: Merchant[], embedding?: number[]): Probe {
  const text = evidenceText(ev);
  const fp = fingerprint(text || ev.order.merchantDisplayName || "empty");
  const features = computeFeatures(ev, registry);
  return {
    text,
    minhash: fp.minhash,
    shingleCount: fp.shingleCount,
    features,
    skeleton: sellerSkeleton(ev.order, features),
    ...(embedding ? { embedding } : {}),
  };
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const KIND_RANK: Record<ImmuneMatch["kind"], number> = {
  skeleton: 3,
  features: 2,
  minhash: 1,
  embedding: 0,
};

/** Prefer the match with the stronger action, then the structural kind, then similarity. */
export function better(a: ImmuneMatch, b: ImmuneMatch): ImmuneMatch {
  const rank = (m: ImmuneMatch) => (m.action === "VOID" ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) > rank(b) ? a : b;
  if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] > KIND_RANK[b.kind] ? a : b;
  return a.similarity >= b.similarity ? a : b;
}

/**
 * The best match of one antibody against a probe, or null. `antibodyEmbedding` / `cos` let the
 * caller pass a precomputed cosine (the verifier gets it from pgvector) or the vector itself.
 */
export function matchAntibody(
  a: Antibody,
  p: Probe,
  t: MatchThresholds,
  emb: { cosine?: number; antibodyEmbedding?: number[] } = {},
): ImmuneMatch | null {
  const found: ImmuneMatch[] = [];
  const j = estimatedJaccard(a.minhash, p.minhash);
  const contained = t.containment
    ? estimatedContainment(j, t.containment.antibodyShingles, p.shingleCount)
    : 0;
  if (j >= t.jaccard)
    found.push({ antibodyId: a.id, kind: "minhash", similarity: j, action: "ASK_HUMAN" });
  else if (t.containment && contained >= t.containment.threshold)
    found.push({ antibodyId: a.id, kind: "minhash", similarity: contained, action: "ASK_HUMAN" });

  const cos =
    emb.cosine ??
    (emb.antibodyEmbedding && p.embedding ? cosine(emb.antibodyEmbedding, p.embedding) : undefined);
  if (cos !== undefined && cos >= t.cosine)
    found.push({ antibodyId: a.id, kind: "embedding", similarity: cos, action: "ASK_HUMAN" });

  const f = featureMatch(a.features, p.features);
  if (f !== null)
    found.push({ antibodyId: a.id, kind: "features", similarity: f, action: a.action });

  if (a.skeleton && p.skeleton && a.skeleton === p.skeleton)
    found.push({ antibodyId: a.id, kind: "skeleton", similarity: 1, action: a.action });

  return found.length ? found.reduce(better) : null;
}
