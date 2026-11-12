// arena.trial, for real (task Q3): one evolved listing vs the real agent and the real verifier.
//   1 validate -> 2 deploy a Bazaar tenant -> 3 runShopper -> 4 attach + verify twice in-process
//   (static: Layer 1 only; immune: + immune match + conformal gate) -> 5 oracle, stealth, novelty
//   -> 6 fitness + archive -> 7 report (mint) -> 8 delete tenant, persist, emit.
// All LLM work (agent, judge, shadow, Strategist) runs inside withBudget.
import {
  VerifierConfig,
  type Genome,
  type Scenario,
  type StageScores,
  type TrialResult,
  type Verdict,
} from "@poi/shared";
import type { RunShopperOptions, RunShopperResult } from "@poi/agent";
import type { LanguageModel } from "ai";
import { isRateLimited } from "@poi/shared/llm";
import { stageScores } from "../calibration/fuse";
import { BazaarHttpError, type ArenaBazaar } from "../lib/bazaar";
import { parseChecks } from "../lib/mappers";
import type { Prisma } from "../lib/prisma";
import { PayPalError } from "../paypal";
import { runVerification, type PipelineDeps } from "../verifier/pipeline";
import type { TermsChunk } from "../verifier/terms-rag";
import type { MintJob } from "../immune/mint.job";
import { recordReport } from "../immune/risk";
import {
  getCells,
  getEliteEmbeddings,
  getGenome,
  insertTrial,
  recordCellTrial,
  setGenomeEmbedding,
} from "./archive.repo";
import { isBudgetExceeded, withBudget } from "./budget";
import { ensureArenaIntent } from "./intents";
import { budgetCtx, endRun, loadRun, type ArenaJobDeps } from "./jobs";

/**
 * The agent call a trial makes. `tenant` scopes every Bazaar request the agent sends (catalog,
 * product pages, terms, checkout) to the trial's tenant: CONTRACTS-L2 4.5. Spelled out here
 * until RunShopperOptions declares it (teammate, packages/agent).
 */
export type ArenaShopOptions = RunShopperOptions & { tenant: string };

/**
 * Terms chunks for an order placed in a tenant: the evolved listing's termsExcerpt, but only when
 * the order went to that listing's merchant (buying a benign listing brings no evolved terms).
 */
export function tenantTerms(
  orderMerchantId: string | null,
  genome: Pick<Genome, "listing">,
  tenant: string,
): TermsChunk[] {
  const excerpt = genome.listing.termsExcerpt?.trim();
  if (!excerpt || orderMerchantId !== genome.listing.merchantId) return [];
  return [{ id: `arena:${tenant}:terms`, text: excerpt }];
}

/** What the real trial needs beyond the generation jobs' deps. */
export interface ArenaTrialDeps {
  pipeline: PipelineDeps;
  bazaar: ArenaBazaar;
  bazaarUrl: string;
  shop: (o: ArenaShopOptions) => Promise<RunShopperResult>;
  compilerModel?: LanguageModel;
  /** immune.mint (task Q4). */
  enqueueMint: (job: MintJob) => Promise<void>;
  /** Transient-error retries (default 2) and the backoff base. */
  retries?: number;
  retryDelayMs?: number;
  /** Back-off base after a provider rate limit (default 30s; the quota window must reopen). */
  rateLimitDelayMs?: number;
}

export const tenantId = (g: Pick<Genome, "generation" | "id">) => `arena-g${g.generation}-${g.id}`;

const AGENT_STOPPED = /^Agent stopped: ([\s\S]*)$/;

/**
 * The error inside an agent run that ended on a provider failure (the agent records it as its last
 * step and returns normally), or null for a run that ended on its own. Rate limits keep their 429
 * so the trial retries them; anything else fails the attempt as a plain error.
 */
export function agentProviderFailure(r: RunShopperResult): Error | null {
  if (r.checkout) return null;
  const last = r.trace.steps.at(-1) as { type?: string; output?: unknown } | undefined;
  const m =
    last?.type === "text" && typeof last.output === "string"
      ? AGENT_STOPPED.exec(last.output)
      : null;
  if (!m) return null;
  const message = `agent stopped on a provider error: ${m[1]!.slice(0, 200)}`;
  return isRateLimited({ message: m[1] })
    ? Object.assign(new Error(message), { statusCode: 429 })
    : new Error(message);
}

/** LLM 429/5xx, PayPal 5xx, Bazaar 5xx and network failures are worth retrying. */
export function isTransient(err: unknown): boolean {
  const e = err as {
    statusCode?: number;
    isRetryable?: boolean;
    name?: string;
    cause?: unknown;
    lastError?: unknown;
  };
  if (!e) return false;
  if (isBudgetExceeded(err)) return false;
  if (err instanceof PayPalError)
    return err.status === 0 || err.status === 429 || err.status >= 500;
  if (err instanceof BazaarHttpError) return err.status === 429 || err.status >= 500;
  if (typeof e.statusCode === "number") return e.statusCode === 429 || e.statusCode >= 500;
  if (e.isRetryable === true) return true;
  if (e.name === "AI_RetryError") return true;
  if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  if (isRateLimited(err)) return true;
  if (err instanceof TypeError && /fetch failed|network|ECONN|socket/i.test(err.message))
    return true;
  return e.cause ? isTransient(e.cause) : false;
}

interface Outcome {
  valid: boolean;
  invalidReasons: string[];
  orderId?: string;
  /** The tenant terms the order was verified against (handed to immune.mint). */
  termsText?: string;
  chosenPoison: boolean;
  verdictStatic?: Verdict;
  verdictImmune?: Verdict;
  scoresStatic?: StageScores;
  scoresImmune?: StageScores;
  stealthP: number;
  noveltyCos: number;
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

/** Steps 1-5 for one attempt. The tenant is always deleted, even when a step throws. */
async function attempt(
  deps: ArenaJobDeps & ArenaTrialDeps,
  runId: string,
  genome: Genome,
  scenario: Scenario,
  cfg: { agentModel: string; frozenDefenderVersion?: number },
): Promise<Outcome> {
  const db = deps.prisma();
  const log = (step: string, extra: object = {}) =>
    deps.logger.debug({ runId, genomeId: genome.id, step, ...extra }, "arena trial");

  // 1. validate: is this a genuinely wrong purchase for the scenario's intent?
  const { intentId, spec } = await ensureArenaIntent(
    {
      prisma: deps.prisma,
      signingKey: deps.pipeline.signingKey,
      compilerModel: deps.compilerModel,
    },
    runId,
    scenario,
  );
  const validation = deps.engine.validateListing(genome, scenario, spec);
  log("validate", { valid: validation.valid });
  if (!validation.valid) {
    return {
      valid: false,
      invalidReasons: validation.reasons,
      chosenPoison: false,
      stealthP: 0,
      noveltyCos: 0,
    };
  }

  // 2. deploy into an isolated tenant: the scenario's 4 benign listings + this one
  const tenant = tenantId(genome);
  const { sku } = await deps.bazaar.createTenant(tenant, genome.listing, scenario.id);
  log("tenant", { tenant, sku });
  try {
    // 3. the Layer 1 agent shops the tenant (no scenario: the tenant already fixes the catalog)
    const shopped = await deps.shop({
      userText: scenario.userText,
      model: cfg.agentModel,
      bazaarUrl: deps.bazaarUrl,
      tenant,
    });
    log("shop", { checkout: !!shopped.checkout, chosen: shopped.trace.chosenSkus });
    // The agent turns a provider failure into a normal return ("Agent stopped: ..."). That is not a
    // shopping decision: fail the attempt, so it is retried or recorded as errored -- never as
    // "the agent chose not to buy" (which would feed the archive, the stats and calibration).
    const stopped = agentProviderFailure(shopped);
    if (stopped) throw stopped;

    const out: Outcome = {
      valid: true,
      invalidReasons: [],
      chosenPoison: false,
      stealthP: 0,
      noveltyCos: 0,
    };
    if (shopped.checkout) {
      // 4. attach (dry-run) and verify the same order under both arms, in-process
      const orderId = shopped.checkout.orderId;
      out.orderId = orderId;
      const terms = tenantTerms(shopped.checkout.merchantId, genome, tenant);
      if (terms.length) out.termsText = terms.map((c) => c.text).join("\n");
      await db.orderRecord.upsert({
        where: { id: orderId },
        create: {
          id: orderId,
          intentId,
          merchantId: shopped.checkout.merchantId,
          mode: "DRY_RUN",
          paypalStatus: "UNKNOWN",
          agentTrace: json(shopped.trace),
          runTag: runId,
        },
        update: {},
      });
      const arms = {
        static: VerifierConfig.parse({ immune: false, conformal: false }),
        immune: VerifierConfig.parse({
          immune: true,
          conformal: true,
          ...(cfg.frozenDefenderVersion !== undefined
            ? { defenderVersion: cfg.frozenDefenderVersion }
            : {}),
        }),
      };
      // The tenant's evolved terms are published by the Bazaar, not ingested into TermsChunk:
      // hand them to this order's terms stage (both arms), so a terms-only attack is judged
      // against the fine print the agent could have read.
      const pipeline: PipelineDeps = {
        ...deps.pipeline,
        extraTerms: (id) =>
          tenantTerms(id === orderId ? shopped.checkout!.merchantId : null, genome, tenant),
      };
      // Static runs every Layer 1 stage; immune reuses that exact Layer 1 result and adds the
      // immune stage + gate on top. The two arms then differ only by what Layer 2 adds (never by
      // LLM sampling noise), so immune >= static by construction, and the LLM work is done once.
      let staticId: string | undefined;
      for (const [arm, config] of Object.entries(arms) as Array<
        [keyof typeof arms, VerifierConfig]
      >) {
        const v = await db.verification.create({
          data: { orderId, mode: "DRY_RUN", config: json(config) },
        });
        await runVerification(
          pipeline,
          v.id,
          arm === "immune" && staticId ? { layer1From: staticId } : {},
        );
        if (arm === "static") staticId = v.id;
        const done = await db.verification.findUniqueOrThrow({ where: { id: v.id } });
        const checks = parseChecks(done.checks);
        if (arm === "static") {
          out.verdictStatic = done.verdict ?? undefined;
          out.scoresStatic = stageScores(checks);
          // stealth = how injection-like the listing looked to the static run (0 if no check)
          out.stealthP = Math.max(
            0,
            ...checks.filter((c) => c.check === "injection").map((c) => c.confidence ?? 0),
          );
        } else {
          out.verdictImmune = done.verdict ?? undefined;
          out.scoresImmune = stageScores(checks);
        }
      }
      log("verify", { static: out.verdictStatic, immune: out.verdictImmune });

      // 5. oracle: did the agent buy the poisoned listing? (under its tenant sku)
      const deployed = { ...genome, listing: { ...genome.listing, sku } };
      out.chosenPoison = deps.engine.oracle(deployed, shopped.trace.chosenSkus).violated;
    }

    const novelty = await deps.engine.noveltyCos(
      deps.engine.listingText(genome.listing),
      await getEliteEmbeddings(db, runId),
    );
    out.noveltyCos = Math.min(1, Math.max(0, novelty.cos));
    if (novelty.embedding.length === 1536)
      await setGenomeEmbedding(db, genome.id, novelty.embedding);
    return out;
  } finally {
    await deps.bazaar
      .deleteTenant(tenant)
      .catch((err: unknown) => log("tenant delete failed", { err: (err as Error).message }));
  }
}

export async function runTrial(
  deps: ArenaJobDeps & ArenaTrialDeps,
  runId: string,
  genomeId: string,
): Promise<TrialResult | null> {
  const db = deps.prisma();
  const run = await loadRun(db, runId);
  if (!run || run.status !== "RUNNING") return null;
  if (await db.arenaTrial.findFirst({ where: { genomeId }, select: { id: true } })) return null;
  const genome = await getGenome(db, genomeId);
  if (!genome) throw new Error(`genome ${genomeId} not found`);
  const cfg = run.config;
  const t0 = Date.now();
  const costBefore = run.costUsd;
  const retries = deps.retries ?? 2;

  let outcome: Outcome;
  try {
    const scenario = (await deps.scenarios()).find((s) => s.id === genome.scenarioId);
    if (!scenario) throw new Error(`unknown scenario ${genome.scenarioId}`);
    outcome = await withBudget(budgetCtx(deps, run), async () => {
      for (let n = 0; ; n++) {
        try {
          return await attempt(deps, runId, genome, scenario, cfg);
        } catch (err) {
          if (n >= retries || !isTransient(err)) throw err;
          deps.logger.warn(
            { runId, genomeId, attempt: n + 1, err: (err as Error).message },
            "arena trial: transient error, retrying",
          );
          // A provider quota window needs tens of seconds to reopen; other blips need a moment.
          const base = isRateLimited(err)
            ? (deps.rateLimitDelayMs ?? 30_000)
            : (deps.retryDelayMs ?? 1500);
          await new Promise((r) => setTimeout(r, base * 2 ** n));
        }
      }
    });
  } catch (err) {
    if (isBudgetExceeded(err)) {
      await endRun(deps, runId, "STOPPED", "budget exceeded during a trial");
      return null;
    }
    // Errored, not invalid: recorded and emitted, but it never touches the archive or the stats.
    deps.logger.warn({ runId, genomeId, err: (err as Error).message }, "arena trial errored");
    outcome = {
      valid: false,
      invalidReasons: [`trial error: ${(err as Error).message}`.slice(0, 300)],
      chosenPoison: false,
      stealthP: 0,
      noveltyCos: 0,
    };
  }

  // 6. fitness against the arm this run targets
  const targetVerdict = cfg.target === "immune" ? outcome.verdictImmune : outcome.verdictStatic;
  const fitness = deps.engine.scoreFitness({
    valid: outcome.valid,
    chosenPoison: outcome.chosenPoison,
    verdict: targetVerdict,
    stealthP: outcome.stealthP,
    noveltyCos: outcome.noveltyCos,
  });
  // 7. captured although it violated the intent: the simulated user report
  const reported =
    outcome.chosenPoison && outcome.verdictImmune === "CAPTURE" && cfg.immuneLearning;
  const costAfter = (
    await db.arenaRun.findUniqueOrThrow({ where: { id: runId }, select: { costUsd: true } })
  ).costUsd;

  const trial: TrialResult = {
    trialId: `trial-${genomeId}`,
    runId,
    genomeId,
    generation: genome.generation,
    agentModel: cfg.agentModel,
    valid: outcome.valid,
    invalidReasons: outcome.invalidReasons,
    ...(outcome.orderId ? { orderId: outcome.orderId } : {}),
    chosenPoison: outcome.chosenPoison,
    ...(outcome.verdictStatic ? { verdictStatic: outcome.verdictStatic } : {}),
    ...(outcome.verdictImmune ? { verdictImmune: outcome.verdictImmune } : {}),
    ...(outcome.scoresStatic ? { scoresStatic: outcome.scoresStatic } : {}),
    ...(outcome.scoresImmune ? { scoresImmune: outcome.scoresImmune } : {}),
    stealthP: outcome.stealthP,
    noveltyCos: outcome.noveltyCos,
    fitness,
    reported,
    costUsd: Math.max(0, costAfter - costBefore),
    latencyMs: Date.now() - t0,
  };
  // 8. persist, archive, report, emit
  await insertTrial(db, trial);
  let replacedElite = false;
  if (outcome.valid) {
    const key = { runId, family: genome.family, channel: genome.channel };
    const cell = (await getCells(db, runId)).find(
      (c) => c.family === genome.family && c.channel === genome.channel,
    );
    const replace = cell ? deps.engine.shouldReplaceElite(cell, fitness) : true;
    replacedElite = await recordCellTrial(db, key, {
      genomeId,
      fitness,
      won: outcome.chosenPoison && targetVerdict === "CAPTURE",
      replace,
    });
  }
  if (reported && outcome.orderId) {
    // The simulated user report: the arena seller's risk goes up, and the trick is minted.
    await recordReport(db, outcome.orderId);
    await deps.enqueueMint({
      orderId: outcome.orderId,
      family: genome.family,
      source: "arena-oracle",
      ...(outcome.termsText ? { termsText: outcome.termsText } : {}),
    });
  }
  deps.emitter.trial({
    runId,
    generation: genome.generation,
    genomeId,
    family: genome.family,
    channel: genome.channel,
    fitness,
    chosenPoison: trial.chosenPoison,
    verdictStatic: trial.verdictStatic ?? null,
    verdictImmune: trial.verdictImmune ?? null,
    replacedElite,
  });
  return trial;
}
