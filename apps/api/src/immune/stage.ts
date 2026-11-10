// The immune stage (CONTRACTS-L2 5.2 step 6, 5.3): runs after the Layer 1 stages when
// config.immune is true. It matches the order against the live antibodies (or exactly those of a
// pinned defender version) and checks the seller's risk. It only ever adds checks; the verdict
// is still the lattice's max, so it can raise a verdict and never lower one.
import type { EmbeddingModel } from "ai";
import type {
  AgentTrace,
  Antibody,
  CheckResult,
  ImmuneMatch,
  Merchant,
  MerchantRiskSnapshot,
  NormalizedOrder,
} from "@poi/shared";
import type { PrismaClient } from "../lib/prisma";
import { liveAntibodies, nearestByEmbedding } from "./antibody.repo";
import { chosenPageText } from "./features";
import { better, buildProbe, embedText, matchAntibody } from "./match";
import { getRisk, riskCheck } from "./risk";

export interface ImmuneStageInput {
  order: NormalizedOrder;
  trace: AgentTrace;
  /** Terms beyond TermsChunk (an arena tenant's excerpt), as used at mint time. */
  termsText?: string;
  registry: Merchant[];
  /** Exactly these antibodies (a pinned defender snapshot); undefined = all ACTIVE. */
  antibodyIds?: string[];
  riskKey: string;
  thresholds: { jaccard: number; cosine: number; riskAsk: number };
  embeddingModel?: EmbeddingModel;
}

export interface ImmuneStageResult {
  matches: ImmuneMatch[];
  antibodies: Antibody[];
  risk: MerchantRiskSnapshot;
  checks: CheckResult[];
}

const FAMILY_WORDS: Record<Antibody["family"], string> = {
  injection: "hidden-instruction",
  subscription: "hidden-subscription",
  variant: "wrong-variant",
  addon: "pre-added extra",
  lookalike: "look-alike seller",
  dripfee: "drip-fee",
  tosrenew: "renewal-in-the-terms",
};

const KIND_WORDS: Record<ImmuneMatch["kind"], string> = {
  minhash: "near-identical wording",
  embedding: "same meaning, new wording",
  features: "same structure",
  skeleton: "same look-alike seller name",
};

export async function runImmuneStage(
  db: PrismaClient,
  i: ImmuneStageInput,
): Promise<ImmuneStageResult> {
  const t0 = performance.now();
  const antibodies = await liveAntibodies(db, i.antibodyIds);
  const pageText = chosenPageText(i.trace);
  const evidence = { order: i.order, pageText, ...(i.termsText ? { termsText: i.termsText } : {}) };

  let probe = buildProbe(evidence, i.registry);
  const cosines = new Map<string, number>();
  if (i.embeddingModel && antibodies.length) {
    const embedding = await embedText(i.embeddingModel, probe.text).catch(() => undefined);
    if (embedding) {
      probe = { ...probe, embedding };
      for (const n of await nearestByEmbedding(db, embedding, {
        k: 5,
        ids: antibodies.map((a) => a.id),
      }))
        cosines.set(n.id, n.cosine);
    }
  }

  const matches = antibodies.flatMap((a) => {
    const m = matchAntibody(a, probe, i.thresholds, { cosine: cosines.get(a.id) });
    return m ? [m] : [];
  });
  const checks: CheckResult[] = [];
  const latencyMs = Math.round(performance.now() - t0);

  if (matches.length) {
    const top = matches.reduce(better);
    const a = antibodies.find((x) => x.id === top.antibodyId)!;
    const others = matches.length - 1;
    checks.push({
      check: "immune",
      stage: "semantic",
      outcome: "fail",
      severity: top.action === "VOID" ? "high" : "medium",
      expected: "no known trick",
      actual: `${FAMILY_WORDS[a.family]} (${KIND_WORDS[top.kind]}, ${Math.round(top.similarity * 100)}%)`,
      reason:
        `This order matches a ${FAMILY_WORDS[a.family]} trick POI learned from an earlier order ` +
        `(${KIND_WORDS[top.kind]})${others ? `, plus ${others} more` : ""}.`,
      confidence: Math.min(1, top.similarity),
      latencyMs,
    });
  } else {
    checks.push({
      check: "immune",
      stage: "semantic",
      outcome: "pass",
      severity: "low",
      reason: `No known trick matched (${antibodies.length} learned antibodies checked).`,
      latencyMs,
    });
  }

  const risk = await getRisk(db, i.riskKey);
  checks.push(riskCheck(risk, i.thresholds.riskAsk));
  return {
    matches,
    antibodies: antibodies.filter((a) => matches.some((m) => m.antibodyId === a.id)),
    risk,
    checks,
  };
}
