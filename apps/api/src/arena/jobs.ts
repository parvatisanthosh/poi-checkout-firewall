// Arena jobs (CONTRACTS-L2 4.3). One generation = propose (persist genomes) -> N trials ->
// finalize (stats, Strategist, next generation). The queue (queue.ts) decides how they run:
// a BullMQ flow (finalize is the parent of the trials) or in-process.
import { createHash } from "node:crypto";
import {
  ArenaRunConfig,
  type ArenaEngine,
  type ArenaRunStatus,
  type Scenario,
  type TrialResult,
} from "@poi/shared";
import type { Logger } from "../lib/logger";
import type { PrismaClient } from "../lib/prisma";
import type { ArenaEmitter } from "../realtime/arena-emitter";
import { getDefender } from "../immune/defender";
import {
  getCells,
  getElites,
  getGenome,
  getTrialsForGeneration,
  insertGenome,
  listStrategies,
  recordGeneration,
  setRunStatus,
  upsertStrategies,
} from "./archive.repo";
import { effectiveMaxUsd, isBudgetExceeded, withBudget, type BudgetContext } from "./budget";

export interface ArenaJobDeps {
  prisma: () => PrismaClient;
  engine: ArenaEngine;
  emitter: ArenaEmitter;
  logger: Logger;
  scenarios: () => Promise<Scenario[]>;
  /** Called by finalize to start the next generation. */
  enqueueGeneration: (runId: string, generation: number) => Promise<void>;
}

const ACTIVE: ArenaRunStatus[] = ["QUEUED", "RUNNING"];
const hashSeed = (s: string) => createHash("sha256").update(s).digest().readUInt32BE(0);

export async function loadRun(db: PrismaClient, runId: string) {
  const run = await db.arenaRun.findUnique({ where: { id: runId } });
  return run ? { ...run, config: ArenaRunConfig.parse(run.config) } : null;
}

export function budgetCtx(
  deps: ArenaJobDeps,
  run: { id: string; config: ArenaRunConfig; status: ArenaRunStatus },
): BudgetContext {
  return {
    db: deps.prisma(),
    runId: run.id,
    maxUsd: effectiveMaxUsd(run.config.maxUsd),
    onCharge: (costUsd) => deps.emitter.run({ runId: run.id, status: run.status, costUsd }),
  };
}

/** End a run (STOPPED / DONE / ERROR) and tell the room. No-op if it already ended. */
export async function endRun(
  deps: ArenaJobDeps,
  runId: string,
  status: Exclude<ArenaRunStatus, "QUEUED" | "RUNNING">,
  why?: string,
) {
  const db = deps.prisma();
  const r = await db.arenaRun.updateMany({
    where: { id: runId, status: { in: ACTIVE } },
    data: { status },
  });
  if (r.count === 0) return;
  const run = await db.arenaRun.findUniqueOrThrow({
    where: { id: runId },
    select: { costUsd: true },
  });
  deps.logger.info({ runId, status, why }, "arena run ended");
  deps.emitter.run({ runId, status, costUsd: run.costUsd });
}

/**
 * Propose and persist one generation's genomes. Returns their ids ([] if the run ended).
 * Idempotent: a retry after the genomes were saved returns the saved ids instead of re-proposing.
 */
export async function proposeGeneration(
  deps: ArenaJobDeps,
  runId: string,
  generation: number,
): Promise<string[]> {
  const db = deps.prisma();
  const run = await loadRun(db, runId);
  if (!run || !ACTIVE.includes(run.status)) return [];
  if (run.status === "QUEUED") {
    await setRunStatus(db, runId, "RUNNING");
    run.status = "RUNNING";
    deps.emitter.run({ runId, status: "RUNNING", costUsd: run.costUsd });
  }
  const existing = await db.attackGenome.findMany({
    where: { runId, generation },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (existing.length) return existing.map((g) => g.id);

  const cfg = run.config;
  try {
    const [archive, elites, library, allScenarios] = await Promise.all([
      getCells(db, runId),
      getElites(db, runId),
      listStrategies(db),
      deps.scenarios(),
    ]);
    const scenarios = cfg.scenarioIds
      ? allScenarios.filter((s) => cfg.scenarioIds!.includes(s.id))
      : allScenarios;
    const drafts = await withBudget(budgetCtx(deps, run), () =>
      deps.engine.proposeGeneration({
        runId,
        generation,
        populationSize: cfg.populationSize,
        archive,
        elites,
        library,
        families: cfg.families,
        scenarios,
        attackerModel: cfg.attackerModel,
        seed: hashSeed(runId) + generation,
      }),
    );
    const ids: string[] = [];
    for (const d of drafts.slice(0, cfg.populationSize)) {
      const g = await insertGenome(db, {
        ...d,
        runId,
        generation,
        split: cfg.split,
        attackerModel: cfg.attackerModel,
      });
      ids.push(g.id);
    }
    deps.logger.info({ runId, generation, genomes: ids.length }, "arena generation proposed");
    return ids;
  } catch (err) {
    if (isBudgetExceeded(err)) {
      await endRun(deps, runId, "STOPPED", "budget exceeded while proposing");
      return [];
    }
    throw err;
  }
}

const rate = (trials: TrialResult[], arm: "verdictStatic" | "verdictImmune") => {
  const valid = trials.filter((t) => t.valid);
  if (!valid.length) return 0;
  return (
    Math.round(
      (valid.filter((t) => t.chosenPoison && t[arm] === "CAPTURE").length / valid.length) * 10000,
    ) / 10000
  );
};

/** After every trial of a generation: stats, Strategist, then the next generation or DONE. */
export async function finalizeGeneration(
  deps: ArenaJobDeps,
  runId: string,
  generation: number,
): Promise<void> {
  const db = deps.prisma();
  const run = await loadRun(db, runId);
  if (!run || run.status !== "RUNNING") return;
  const trials = await getTrialsForGeneration(db, runId, generation);
  const cells = await getCells(db, runId);
  const stats = {
    generation,
    asrStatic: rate(trials, "verdictStatic"),
    asrImmune: rate(trials, "verdictImmune"),
    coverage: cells.filter((c) => c.eliteGenomeId).length,
    bestFitness: Math.max(0, ...cells.map((c) => c.eliteFitness ?? 0)),
    defenderVersion: (await getDefender(db)).version,
  };
  await recordGeneration(db, runId, stats);
  deps.emitter.generation({ runId, ...stats });

  try {
    const genomes = await db.attackGenome.findMany({
      where: { runId, generation },
      select: { id: true },
    });
    const library = await withBudget(budgetCtx(deps, run), async () =>
      deps.engine.summarizeStrategies({
        genomes: (await Promise.all(genomes.map((g) => getGenome(db, g.id)))).filter(
          (g) => g !== null,
        ),
        trials,
        library: await listStrategies(db),
        model: run.config.attackerModel,
      }),
    );
    await upsertStrategies(db, library);
  } catch (err) {
    if (isBudgetExceeded(err))
      return endRun(deps, runId, "STOPPED", "budget exceeded in the Strategist");
    throw err;
  }

  const fresh = await loadRun(db, runId);
  if (!fresh || fresh.status !== "RUNNING") return;
  if (generation + 1 < fresh.config.generations)
    await deps.enqueueGeneration(runId, generation + 1);
  else await endRun(deps, runId, "DONE");
}
