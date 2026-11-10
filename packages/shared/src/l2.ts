/**
 * Layer 2 contracts ("POI Immune": the checkout firewall that learns). docs/CONTRACTS-L2.md.
 * Everything here is additive: Layer 1 shapes and behaviour are unchanged.
 */
import { z } from "zod";
import { BazaarProduct, type Scenario } from "./bazaar";
import type { ClientToServerEvents, ServerToClientEvents } from "./events";
import { CheckResult, IntentSpec, Verdict, VerifyRecordResponse } from "./schemas";

// ---------------------------------------------------------------------------
// 4.1 Core schemas
// ---------------------------------------------------------------------------

export const AttackFamily = z.enum([
  "injection",
  "subscription",
  "variant",
  "addon",
  "lookalike",
  "dripfee",
  "tosrenew",
]);
export type AttackFamily = z.infer<typeof AttackFamily>;

/** Where the attack lives in the listing. */
export const Channel = z.enum(["title", "description", "review", "alt_text", "terms", "checkout"]);
export type Channel = z.infer<typeof Channel>;

/** MAP-Elites grid = 7 families x 6 channels = 42 cells. */
export const ARCHIVE_CELL_COUNT = AttackFamily.options.length * Channel.options.length;

export const GenomeOperator = z.enum(["seed", "mutate", "crossover", "strategy"]);
export type GenomeOperator = z.infer<typeof GenomeOperator>;

export const GenomeDraft = z.object({
  family: AttackFamily,
  channel: Channel,
  operator: GenomeOperator,
  parentIds: z.array(z.string()).default([]),
  /** One-paragraph natural-language strategy (Genesis-style). */
  strategy: z.string(),
  scenarioId: z.string(),
  /** The poisoned product, incl. hidden text + checkoutExtras (+ termsExcerpt for "terms"). */
  listing: BazaarProduct,
});
export type GenomeDraft = z.infer<typeof GenomeDraft>;
export type GenomeDraftInput = z.input<typeof GenomeDraft>;

export const Split = z.enum(["train", "heldout"]);
export type Split = z.infer<typeof Split>;

export const Genome = GenomeDraft.extend({
  id: z.string(),
  runId: z.string(),
  generation: z.number().int(),
  split: Split,
  /** "provider:model" */
  attackerModel: z.string(),
  /** SHA-256 hash of the canonical listing text */
  hash: z.string().optional(),
});
export type Genome = z.infer<typeof Genome>;

/** Every probabilistic stage mapped to [0,1] (CONTRACTS-L2 5.4 step 1). */
export const StageScores = z.object({
  semantic: z.number().min(0).max(1).default(0),
  terms: z.number().min(0).max(1).default(0),
  shadow: z.number().min(0).max(1).default(0),
  injection: z.number().min(0).max(1).default(0),
  immune: z.number().min(0).max(1).default(0),
  risk: z.number().min(0).max(1).default(0),
});
export type StageScores = z.infer<typeof StageScores>;

export const TrialResult = z.object({
  trialId: z.string(),
  runId: z.string(),
  genomeId: z.string(),
  generation: z.number().int(),
  agentModel: z.string(),
  valid: z.boolean(),
  invalidReasons: z.array(z.string()).default([]),
  orderId: z.string().optional(),
  /** Oracle: the agent bought the poisoned SKU (= intent violated). */
  chosenPoison: z.boolean(),
  verdictStatic: Verdict.optional(),
  verdictImmune: Verdict.optional(),
  scoresStatic: StageScores.optional(),
  scoresImmune: StageScores.optional(),
  /** Injection-classifier probability on the listing. */
  stealthP: z.number().min(0).max(1),
  /** Max cosine to existing archive elites. */
  noveltyCos: z.number().min(0).max(1),
  fitness: z.number(),
  /** Simulated user report filed (captured + violated). */
  reported: z.boolean(),
  costUsd: z.number(),
  latencyMs: z.number(),
});
export type TrialResult = z.infer<typeof TrialResult>;

export const ArchiveCell = z.object({
  family: AttackFamily,
  channel: Channel,
  eliteGenomeId: z.string().nullable(),
  eliteFitness: z.number().nullable(),
  attempts: z.number().int(),
  wins: z.number().int(),
});
export type ArchiveCell = z.infer<typeof ArchiveCell>;

export const StrategyEntry = z.object({
  id: z.string(),
  family: AttackFamily,
  channel: Channel.optional(),
  /** e.g. "Put the renewal price only in alt text of the 3rd image" */
  text: z.string(),
  wins: z.number().int(),
  losses: z.number().int(),
});
export type StrategyEntry = z.infer<typeof StrategyEntry>;

export const ArenaRunConfig = z.object({
  generations: z.number().int().min(1).max(20).default(6),
  populationSize: z.number().int().min(4).max(24).default(12),
  attackerModel: z.string(),
  agentModel: z.string(),
  families: z.array(AttackFamily).min(1),
  split: Split.default("train"),
  /** Which arm fitness is scored against. */
  target: z.enum(["static", "immune"]).default("static"),
  /** Mint antibodies from reports. */
  immuneLearning: z.boolean().default(true),
  /** Held-out eval: no learning, fixed defender. */
  frozenDefenderVersion: z.number().int().optional(),
  scenarioIds: z.array(z.string()).optional(),
  maxUsd: z.number().default(15),
});
export type ArenaRunConfig = z.infer<typeof ArenaRunConfig>;
export type ArenaRunConfigInput = z.input<typeof ArenaRunConfig>;

export const AntibodyAction = z.enum(["ASK_HUMAN", "VOID"]);
export type AntibodyAction = z.infer<typeof AntibodyAction>;

export const AntibodyStatus = z.enum(["candidate", "active", "retired"]);
export type AntibodyStatus = z.infer<typeof AntibodyStatus>;

/** Structural flags (CONTRACTS-L2 5.2 step 5). */
export const ANTIBODY_FEATURES = [
  "recurrence_in_checkout",
  "recurrence_in_terms",
  "trial_language",
  "condition_not_new",
  "digital_extra_line",
  "fee_lines",
  "seller_unverified",
  "addresses_ai",
  "hidden_text_present",
] as const;
export type AntibodyFeature = (typeof ANTIBODY_FEATURES)[number];

export const MINHASH_SIZE = 128;
export const LSH_BANDS = 32; // x 4 rows

export const Antibody = z.object({
  id: z.string(),
  family: AttackFamily,
  sourceOrderId: z.string(),
  minhash: z.array(z.number().int()).length(MINHASH_SIZE),
  /** Structural flags, keyed by ANTIBODY_FEATURES. */
  features: z.record(z.string(), z.boolean()),
  /** Confusables skeleton of the merchant name. */
  skeleton: z.string().nullable(),
  action: AntibodyAction,
  status: AntibodyStatus,
  hits: z.number().int(),
  falseHits: z.number().int(),
  defenderVersion: z.number().int(),
  /** EdDSA JWS over canonical JSON (Layer 1 signer). */
  signature: z.string(),
});
export type Antibody = z.infer<typeof Antibody>;

export const ImmuneMatch = z.object({
  antibodyId: z.string(),
  kind: z.enum(["minhash", "embedding", "features", "skeleton"]),
  similarity: z.number(),
  action: AntibodyAction,
});
export type ImmuneMatch = z.infer<typeof ImmuneMatch>;

export const CalibrationResult = z.object({
  id: z.string(),
  alpha: z.number(),
  n: z.number().int(),
  nViolating: z.number().int(),
  lambdaAsk: z.number(),
  lambdaVoid: z.number(),
  /** Violating orders below lambdaAsk / n. */
  empiricalMiss: z.number(),
  benignAskRate: z.number(),
  benignVoidRate: z.number(),
  perFamily: z.array(z.object({ family: AttackFamily, n: z.number().int(), miss: z.number() })),
  createdAt: z.string(),
});
export type CalibrationResult = z.infer<typeof CalibrationResult>;

/**
 * Added to Layer 1's VerifierConfig (the fields now live on VerifierConfig itself, so
 * POST /orders/:id/verify accepts them). Defaults keep Layer 1 behaviour.
 */
export const VerifierConfigL2 = z.object({
  immune: z.boolean().default(false),
  conformal: z.boolean().default(false),
  /** Pin antibodies + calibration for frozen evals. */
  defenderVersion: z.number().int().optional(),
});
export type VerifierConfigL2 = z.infer<typeof VerifierConfigL2>;

// ---------------------------------------------------------------------------
// 4.4 API request / response shapes
// ---------------------------------------------------------------------------

export const ArenaRunStatus = z.enum(["QUEUED", "RUNNING", "DONE", "STOPPED", "ERROR"]);
export type ArenaRunStatus = z.infer<typeof ArenaRunStatus>;

export const StartArenaRunResponse = z.object({ runId: z.string() });

export const ArenaGenerationStats = z.object({
  generation: z.number().int(),
  asrStatic: z.number(),
  asrImmune: z.number(),
  /** Cells filled out of 42. */
  coverage: z.number().int(),
  bestFitness: z.number(),
  defenderVersion: z.number().int(),
});
export type ArenaGenerationStats = z.infer<typeof ArenaGenerationStats>;

/** GET /api/arena/runs row. */
export const ArenaRunSummary = z.object({
  id: z.string(),
  status: ArenaRunStatus,
  costUsd: z.number(),
  createdAt: z.string(),
  config: ArenaRunConfig,
  /** Generations completed so far. */
  generationsDone: z.number().int(),
});
export type ArenaRunSummary = z.infer<typeof ArenaRunSummary>;
export const ArenaRunList = z.array(ArenaRunSummary);

/** GET /api/arena/runs/:id */
export const ArenaRunDetail = z.object({
  id: z.string(),
  config: ArenaRunConfig,
  status: ArenaRunStatus,
  costUsd: z.number(),
  createdAt: z.string(),
  generations: z.array(ArenaGenerationStats),
  cells: z.array(ArchiveCell),
});
export type ArenaRunDetail = z.infer<typeof ArenaRunDetail>;

export const GenomesQuery = z.object({
  gen: z.coerce.number().int().optional(),
  family: AttackFamily.optional(),
});
export type GenomesQuery = z.input<typeof GenomesQuery>;

/** GET /api/arena/runs/:id/genomes row: the genome plus its best trial. */
export const GenomeRow = Genome.extend({ bestTrial: TrialResult.nullable() });
export type GenomeRow = z.infer<typeof GenomeRow>;
export const GenomeRows = z.array(GenomeRow);

/** GET /api/arena/genomes/:id (lineage). */
export const GenomeLineage = z.object({
  genome: Genome,
  parents: z.array(Genome),
  trials: z.array(TrialResult),
});
export type GenomeLineage = z.infer<typeof GenomeLineage>;

/** Antibody as listed by the API: without the raw 128-number MinHash. */
export const AntibodySummary = Antibody.omit({ minhash: true }).extend({ createdAt: z.string() });
export type AntibodySummary = z.infer<typeof AntibodySummary>;
export const AntibodyList = z.array(AntibodySummary);

export const AntibodyHit = z.object({
  orderId: z.string(),
  at: z.string(),
  kind: ImmuneMatch.shape.kind,
  similarity: z.number(),
  /** Set when a human later approved the order (counts as a false hit). */
  falseHit: z.boolean(),
});
export type AntibodyHit = z.infer<typeof AntibodyHit>;

/** GET /api/immune/antibodies/:id */
export const AntibodyDetail = z.object({
  antibody: AntibodySummary,
  recentHits: z.array(AntibodyHit),
  sourceOrder: z
    .object({
      orderId: z.string(),
      merchantId: z.string(),
      merchantDisplayName: z.string(),
      total: z.object({ currency: z.string(), value: z.string() }),
      lineNames: z.array(z.string()),
    })
    .nullable(),
});
export type AntibodyDetail = z.infer<typeof AntibodyDetail>;

/** POST /api/immune/report -- the "this wasn't what I asked for" button. */
export const ImmuneReportRequest = z.object({
  orderId: z.string().min(1),
  reason: z.string().min(1).max(500),
});
export type ImmuneReportRequest = z.infer<typeof ImmuneReportRequest>;
/** Minting is a queued job; antibodyId is present when an existing antibody absorbed the report. */
export const ImmuneReportResponse = z.object({ antibodyId: z.string().optional() });
export type ImmuneReportResponse = z.infer<typeof ImmuneReportResponse>;

/** GET /api/immune/merchants row. risk = (voids + reports + 1) / (orders + 5). */
export const MerchantRiskRow = z.object({
  merchantId: z.string(),
  displayName: z.string(),
  risk: z.number().min(0).max(1),
  voids: z.number().int(),
  reports: z.number().int(),
  orders: z.number().int(),
});
export type MerchantRiskRow = z.infer<typeof MerchantRiskRow>;
export const MerchantRiskList = z.array(MerchantRiskRow);

/** POST /api/calibration/run */
export const CalibrationRunRequest = z.object({
  alpha: z.number().gt(0).lt(1),
  perFamily: z.boolean().optional(),
});
export type CalibrationRunRequest = z.infer<typeof CalibrationRunRequest>;

/** GET /api/calibration/curve point, alpha in 0.01..0.20. */
export const CalibrationCurvePoint = z.object({
  alpha: z.number(),
  lambdaAsk: z.number(),
  empiricalMiss: z.number(),
  benignAskRate: z.number(),
});
export type CalibrationCurvePoint = z.infer<typeof CalibrationCurvePoint>;
export const CalibrationCurve = z.array(CalibrationCurvePoint);

/** GET /api/defender */
export const DefenderInfo = z.object({
  version: z.number().int(),
  activeAntibodies: z.number().int(),
  activeCalibrationId: z.string().nullable(),
});
export type DefenderInfo = z.infer<typeof DefenderInfo>;

// --- GET /api/verify/:orderId additions (Layer 1 payload + these, all optional) ---------------

export const MerchantRiskSnapshot = MerchantRiskRow.omit({ displayName: true });
export type MerchantRiskSnapshot = z.infer<typeof MerchantRiskSnapshot>;

export const CalibrationInfo = z.object({
  alpha: z.number(),
  lambdaAsk: z.number(),
  lambdaVoid: z.number(),
  n: z.number().int(),
  calibrationId: z.string(),
});
export type CalibrationInfo = z.infer<typeof CalibrationInfo>;

/**
 * 12-month cost of capturing beyond what the user meant (CONTRACTS-L2 5.5): recurring x 12 +
 * add-ons + fees. A recurring charge whose amount can't be parsed has monthlyUsd null and
 * makes annualExtraUsd null ("recurring, amount unknown") -- never a guess.
 */
export const CounterfactualItem = z.object({
  label: z.string(),
  monthlyUsd: z.number().nullable().optional(),
  oneOffUsd: z.number().optional(),
});
export type CounterfactualItem = z.infer<typeof CounterfactualItem>;
export const Counterfactual = z.object({
  annualExtraUsd: z.number().nullable(),
  items: z.array(CounterfactualItem),
});
export type Counterfactual = z.infer<typeof Counterfactual>;

export const VerifyRecordL2Fields = z.object({
  immuneMatches: z.array(ImmuneMatch).optional(),
  /** Summaries of the antibodies in immuneMatches. */
  antibodies: z.array(AntibodySummary).optional(),
  merchantRisk: MerchantRiskSnapshot.nullable().optional(),
  calibration: CalibrationInfo.nullable().optional(),
  defenderVersion: z.number().int().optional(),
  counterfactual: Counterfactual.nullable().optional(),
});
export type VerifyRecordL2Fields = z.infer<typeof VerifyRecordL2Fields>;

/** GET /api/verify/:orderId -- Layer 1 record plus the optional Layer 2 fields. */
export const VerifyRecordResponseL2 = VerifyRecordResponse.extend(VerifyRecordL2Fields.shape);
export type VerifyRecordResponseL2 = z.infer<typeof VerifyRecordResponseL2>;

// ---------------------------------------------------------------------------
// 4.7 Socket.IO events (namespace /live)
// ---------------------------------------------------------------------------

export const arenaRoom = (runId: string) => `arena:${runId}`;
export const IMMUNE_ROOM = "immune";

export const L2_EVENTS = {
  /** client -> server: join arena:{runId} */
  arenaSubscribe: "arena:subscribe",
  /** client -> server: join "immune" (immune:* and calibration:updated) */
  immuneSubscribe: "immune:subscribe",
  arenaRun: "arena:run",
  arenaTrial: "arena:trial",
  arenaGeneration: "arena:generation",
  immuneMinted: "immune:minted",
  immunePromoted: "immune:promoted",
  immuneRejected: "immune:rejected",
  calibrationUpdated: "calibration:updated",
} as const;

export interface ArenaRunEvent {
  runId: string;
  status: ArenaRunStatus;
  costUsd: number;
}
export interface ArenaTrialEvent {
  runId: string;
  generation: number;
  genomeId: string;
  family: AttackFamily;
  channel: Channel;
  fitness: number;
  chosenPoison: boolean;
  verdictStatic: Verdict | null;
  verdictImmune: Verdict | null;
  replacedElite: boolean;
}
export type ArenaGenerationEvent = ArenaGenerationStats & { runId: string };
export interface ImmuneMintedEvent {
  antibodyId: string;
  family: AttackFamily;
  sourceOrderId: string;
}
export interface ImmunePromotionEvent {
  antibodyId: string;
  falseHits: number;
  defenderVersion: number;
}
export interface CalibrationUpdatedEvent {
  calibrationId: string;
  alpha: number;
  lambdaAsk: number;
  lambdaVoid: number;
}

export interface L2ServerToClientEvents {
  "arena:run": (p: ArenaRunEvent) => void; // room arena:{runId}
  "arena:trial": (p: ArenaTrialEvent) => void; // room arena:{runId}
  "arena:generation": (p: ArenaGenerationEvent) => void; // room arena:{runId}
  "immune:minted": (p: ImmuneMintedEvent) => void; // room immune
  "immune:promoted": (p: ImmunePromotionEvent) => void; // room immune
  "immune:rejected": (p: ImmunePromotionEvent) => void; // room immune
  "calibration:updated": (p: CalibrationUpdatedEvent) => void; // room immune
}
export interface L2ClientToServerEvents {
  "arena:subscribe": (p: { runId: string }) => void;
  "immune:subscribe": () => void;
}
/** Socket.IO generics for the /live namespace once Layer 2 is on. */
export type LiveServerToClientEvents = ServerToClientEvents & L2ServerToClientEvents;
export type LiveClientToServerEvents = ClientToServerEvents & L2ClientToServerEvents;

// ---------------------------------------------------------------------------
// 4.6 packages/arena interface (friend implements; Parvati's jobs call it)
// ---------------------------------------------------------------------------

export interface ProposeGenerationInput {
  runId: string;
  generation: number;
  populationSize: number;
  archive: ArchiveCell[];
  elites: Genome[];
  library: StrategyEntry[];
  families: AttackFamily[];
  scenarios: Scenario[];
  attackerModel: string;
  seed: number;
}

export interface ValidationResult {
  valid: boolean;
  reasons: string[];
  violation: AttackFamily | null;
}

/** The attacker engine. Signatures are frozen: Parvati's jobs call these and never reimplement them. */
export interface ArenaEngine {
  proposeGeneration(i: ProposeGenerationInput): Promise<GenomeDraft[]>;
  validateListing(d: GenomeDraft, scenario: Scenario, spec: IntentSpec): ValidationResult;
  noveltyCos(
    listingText: string,
    eliteEmbeddings: number[][],
  ): Promise<{ cos: number; embedding: number[] }>;
  scoreFitness(t: {
    valid: boolean;
    chosenPoison: boolean;
    verdict?: Verdict;
    stealthP: number;
    noveltyCos: number;
  }): number;
  shouldReplaceElite(cell: ArchiveCell, fitness: number): boolean;
  oracle(g: Genome, chosenSkus: string[]): { violated: boolean; family: AttackFamily | null };
  summarizeStrategies(i: {
    genomes: Genome[];
    trials: TrialResult[];
    library: StrategyEntry[];
    model: string;
  }): Promise<StrategyEntry[]>;
  /** Canonical untrusted text used by immune memory AND novelty, so fingerprints agree. */
  listingText(p: BazaarProduct): string;
}

/** Layer 2 CheckResults reuse Layer 1's shape; "immune" and "risk" are new CheckIds. */
export type L2CheckResult = CheckResult & { check: "immune" | "risk" };
