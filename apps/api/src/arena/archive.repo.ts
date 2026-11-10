// Arena persistence (CONTRACTS-L2 4.2): runs, generations, genomes, trials, MAP-Elites cells and
// the strategy library. Every function takes the Prisma client (or a transaction) explicitly.
import {
  ArchiveCell,
  ArenaRunConfig,
  AttackFamily,
  BazaarProduct,
  Channel,
  Genome,
  GenomeOperator,
  Split,
  StrategyEntry,
  TrialResult,
  type ArenaGenerationStats,
  type ArenaRunDetail,
  type ArenaRunStatus,
  type ArenaRunSummary,
  type GenomeDraft,
  type GenomeRow,
} from "@poi/shared";
import type { Prisma, PrismaClient } from "../lib/prisma";
import { parseVector, toVectorLiteral } from "../lib/vector";

type Db = PrismaClient | Prisma.TransactionClient;
const json = (v: unknown) => v as Prisma.InputJsonValue;

// --- runs --------------------------------------------------------------------------------

/** Create a run and its 42 empty MAP-Elites cells. */
export async function createRun(db: PrismaClient, config: ArenaRunConfig): Promise<string> {
  return db.$transaction(async (tx) => {
    const run = await tx.arenaRun.create({ data: { config: json(config) } });
    await tx.arenaCell.createMany({
      data: AttackFamily.options.flatMap((family) =>
        Channel.options.map((channel) => ({ runId: run.id, family, channel })),
      ),
    });
    return run.id;
  });
}

export async function setRunStatus(db: Db, runId: string, status: ArenaRunStatus): Promise<void> {
  await db.arenaRun.update({ where: { id: runId }, data: { status } });
}

/** Atomically add spend; returns the new total (the budget guard compares it to maxUsd). */
export async function addRunCost(db: Db, runId: string, usd: number): Promise<number> {
  const run = await db.arenaRun.update({
    where: { id: runId },
    data: { costUsd: { increment: usd } },
    select: { costUsd: true },
  });
  return run.costUsd;
}

export async function listRuns(db: Db): Promise<ArenaRunSummary[]> {
  const rows = await db.arenaRun.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { gens: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    costUsd: r.costUsd,
    createdAt: r.createdAt.toISOString(),
    config: ArenaRunConfig.parse(r.config),
    generationsDone: r._count.gens,
  }));
}

export async function getRunDetail(db: Db, runId: string): Promise<ArenaRunDetail | null> {
  const r = await db.arenaRun.findUnique({
    where: { id: runId },
    include: { gens: { orderBy: { generation: "asc" } }, cells: true },
  });
  if (!r) return null;
  return {
    id: r.id,
    config: ArenaRunConfig.parse(r.config),
    status: r.status,
    costUsd: r.costUsd,
    createdAt: r.createdAt.toISOString(),
    generations: r.gens.map(
      ({ generation, asrStatic, asrImmune, coverage, bestFitness, defenderVersion }) => ({
        generation,
        asrStatic,
        asrImmune,
        coverage,
        bestFitness,
        defenderVersion,
      }),
    ),
    cells: r.cells.map(toCell),
  };
}

/** Upsert one generation's stats (unique per run + generation, so a retried job overwrites). */
export async function recordGeneration(
  db: Db,
  runId: string,
  s: ArenaGenerationStats,
): Promise<void> {
  const data = {
    asrStatic: s.asrStatic,
    asrImmune: s.asrImmune,
    coverage: s.coverage,
    bestFitness: s.bestFitness,
    defenderVersion: s.defenderVersion,
  };
  await db.arenaGeneration.upsert({
    where: { runId_generation: { runId, generation: s.generation } },
    create: { runId, generation: s.generation, ...data },
    update: data,
  });
}

// --- cells -------------------------------------------------------------------------------

const toCell = (c: {
  family: string;
  channel: string;
  eliteGenomeId: string | null;
  eliteFitness: number | null;
  attempts: number;
  wins: number;
}): ArchiveCell =>
  ArchiveCell.parse({
    family: c.family,
    channel: c.channel,
    eliteGenomeId: c.eliteGenomeId,
    eliteFitness: c.eliteFitness,
    attempts: c.attempts,
    wins: c.wins,
  });

export async function getCells(db: Db, runId: string): Promise<ArchiveCell[]> {
  return (await db.arenaCell.findMany({ where: { runId } })).map(toCell);
}

/**
 * Record one trial in its cell: attempts++, wins++ if it won, and replace the elite only if the
 * new fitness is strictly higher. The replacement is a single conditional UPDATE, so two trials
 * finishing at once can't overwrite a better elite with a worse one. Returns whether it replaced.
 */
export async function recordCellTrial(
  db: Db,
  key: { runId: string; family: string; channel: string },
  t: {
    genomeId: string;
    fitness: number;
    won: boolean;
    /** engine.shouldReplaceElite said yes (default) */ replace?: boolean;
  },
): Promise<boolean> {
  const where = { runId_family_channel: key };
  await db.arenaCell.update({
    where,
    data: { attempts: { increment: 1 }, ...(t.won ? { wins: { increment: 1 } } : {}) },
  });
  if (t.replace === false) return false;
  const replaced = await db.arenaCell.updateMany({
    where: { ...key, OR: [{ eliteFitness: null }, { eliteFitness: { lt: t.fitness } }] },
    data: { eliteGenomeId: t.genomeId, eliteFitness: t.fitness },
  });
  return replaced.count > 0;
}

// --- genomes -----------------------------------------------------------------------------

type GenomeRowDb = {
  id: string;
  runId: string;
  generation: number;
  family: string;
  channel: string;
  operator: string;
  parentIds: string[];
  strategy: string;
  scenarioId: string;
  listing: unknown;
  split: string;
  attackerModel: string;
};

const toGenome = (g: GenomeRowDb): Genome =>
  Genome.parse({
    id: g.id,
    runId: g.runId,
    generation: g.generation,
    family: AttackFamily.parse(g.family),
    channel: Channel.parse(g.channel),
    operator: GenomeOperator.parse(g.operator),
    parentIds: g.parentIds,
    strategy: g.strategy,
    scenarioId: g.scenarioId,
    listing: BazaarProduct.parse(g.listing),
    split: Split.parse(g.split),
    attackerModel: g.attackerModel,
  });

export async function insertGenome(
  db: Db,
  g: GenomeDraft & {
    runId: string;
    generation: number;
    split: Genome["split"];
    attackerModel: string;
  },
  embedding?: number[],
): Promise<Genome> {
  const row = await db.attackGenome.create({
    data: {
      runId: g.runId,
      generation: g.generation,
      family: g.family,
      channel: g.channel,
      operator: g.operator,
      parentIds: g.parentIds,
      strategy: g.strategy,
      scenarioId: g.scenarioId,
      listing: json(g.listing),
      split: g.split,
      attackerModel: g.attackerModel,
    },
  });
  if (embedding) await setGenomeEmbedding(db, row.id, embedding);
  return toGenome(row);
}

export async function setGenomeEmbedding(
  db: Db,
  genomeId: string,
  embedding: number[],
): Promise<void> {
  await db.$executeRaw`UPDATE "AttackGenome" SET embedding = ${toVectorLiteral(embedding)}::vector WHERE id = ${genomeId}`;
}

export async function getGenome(db: Db, genomeId: string): Promise<Genome | null> {
  const g = await db.attackGenome.findUnique({ where: { id: genomeId } });
  return g ? toGenome(g) : null;
}

export async function getGenomes(db: Db, ids: string[]): Promise<Genome[]> {
  if (!ids.length) return [];
  return (await db.attackGenome.findMany({ where: { id: { in: ids } } })).map(toGenome);
}

/** Genomes of a run (optionally one generation / family), each with its highest-fitness trial. */
export async function listGenomeRows(
  db: Db,
  runId: string,
  q: { gen?: number; family?: string } = {},
): Promise<GenomeRow[]> {
  const rows = await db.attackGenome.findMany({
    where: {
      runId,
      ...(q.gen !== undefined ? { generation: q.gen } : {}),
      ...(q.family ? { family: q.family } : {}),
    },
    orderBy: [{ generation: "asc" }, { createdAt: "asc" }],
    include: { trials: { orderBy: { fitness: "desc" }, take: 1 } },
  });
  return rows.map((r) => ({
    ...toGenome(r),
    bestTrial: r.trials[0] ? TrialResult.parse(r.trials[0].result) : null,
  }));
}

/** Current elites of a run (the genomes the cells point at). */
export async function getElites(db: Db, runId: string): Promise<Genome[]> {
  const cells = await db.arenaCell.findMany({
    where: { runId, eliteGenomeId: { not: null } },
    select: { eliteGenomeId: true },
  });
  return getGenomes(
    db,
    cells.map((c) => c.eliteGenomeId!),
  );
}

/** Embeddings of a run's elites, for the novelty score. Elites without an embedding are skipped. */
export async function getEliteEmbeddings(db: Db, runId: string): Promise<number[][]> {
  const rows = await db.$queryRaw<Array<{ embedding: string }>>`
    SELECT g.embedding::text AS embedding
    FROM "ArenaCell" c JOIN "AttackGenome" g ON g.id = c."eliteGenomeId"
    WHERE c."runId" = ${runId} AND g.embedding IS NOT NULL`;
  return rows.map((r) => parseVector(r.embedding));
}

// --- trials ------------------------------------------------------------------------------

export async function insertTrial(db: Db, t: TrialResult): Promise<void> {
  const r = TrialResult.parse(t);
  await db.arenaTrial.create({
    data: {
      id: r.trialId,
      genomeId: r.genomeId,
      result: json(r),
      fitness: r.fitness,
      chosenPoison: r.chosenPoison,
      verdictStatic: r.verdictStatic ?? null,
      verdictImmune: r.verdictImmune ?? null,
      reported: r.reported,
    },
  });
}

export async function getTrialsForGenome(db: Db, genomeId: string): Promise<TrialResult[]> {
  const rows = await db.arenaTrial.findMany({ where: { genomeId }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => TrialResult.parse(r.result));
}

export async function getTrialsForGeneration(
  db: Db,
  runId: string,
  generation: number,
): Promise<TrialResult[]> {
  const rows = await db.arenaTrial.findMany({
    where: { genome: { runId, generation } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => TrialResult.parse(r.result));
}

// --- strategy library --------------------------------------------------------------------

export async function listStrategies(db: Db, family?: string): Promise<StrategyEntry[]> {
  const rows = await db.strategyEntry.findMany({
    where: family ? { family } : {},
    orderBy: [{ wins: "desc" }, { losses: "asc" }],
  });
  return rows.map((s) => StrategyEntry.parse({ ...s, channel: s.channel ?? undefined }));
}

/** Upsert the library returned by summarizeStrategies (ids it kept are updated, new ids created). */
export async function upsertStrategies(db: PrismaClient, entries: StrategyEntry[]): Promise<void> {
  await db.$transaction(
    entries.map((e) =>
      db.strategyEntry.upsert({
        where: { id: e.id },
        create: {
          id: e.id,
          family: e.family,
          channel: e.channel ?? null,
          text: e.text,
          wins: e.wins,
          losses: e.losses,
        },
        update: {
          family: e.family,
          channel: e.channel ?? null,
          text: e.text,
          wins: e.wins,
          losses: e.losses,
        },
      }),
    ),
  );
}
