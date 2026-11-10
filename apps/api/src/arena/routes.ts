// Arena endpoints (CONTRACTS-L2 4.4).
import { Router } from "express";
import {
  ArenaRunConfig,
  ArenaRunDetail,
  ArenaRunList,
  GenomeLineage,
  GenomeRows,
  GenomesQuery,
  OkResponse,
  StartArenaRunResponse,
} from "@poi/shared";
import { z } from "zod";
import type { AppDeps } from "../app";
import { HttpError } from "../lib/errors";
import { handle } from "../lib/handler";
import {
  createRun,
  getGenome,
  getGenomes,
  getRunDetail,
  getTrialsForGenome,
  listGenomeRows,
  listRuns,
} from "./archive.repo";
import { endRun } from "./jobs";

const Id = z.object({ id: z.string().min(1).max(64) });
type Deps = Pick<
  AppDeps,
  "prisma" | "arenaQueue" | "arenaEmitter" | "arenaEngine" | "arenaScenarios" | "logger"
>;

export function arenaRouter(deps: Deps): Router {
  const r = Router();
  const jobDeps = () => ({
    prisma: deps.prisma,
    engine: deps.arenaEngine,
    emitter: deps.arenaEmitter,
    logger: deps.logger,
    scenarios: deps.arenaScenarios,
    enqueueGeneration: deps.arenaQueue.enqueueGeneration,
  });

  r.post(
    "/arena/runs",
    handle(
      { body: ArenaRunConfig, response: StartArenaRunResponse, status: 201 },
      async ({ body }) => {
        const runId = await createRun(deps.prisma(), body);
        await deps.arenaQueue.enqueueGeneration(runId, 0);
        return { runId };
      },
    ),
  );

  r.get(
    "/arena/runs",
    handle({ response: ArenaRunList }, () => listRuns(deps.prisma())),
  );

  r.get(
    "/arena/runs/:id",
    handle({ params: Id, response: ArenaRunDetail }, async ({ params }) => {
      const run = await getRunDetail(deps.prisma(), params.id);
      if (!run) throw new HttpError(404, "RUN_NOT_FOUND", `Arena run ${params.id} not found`);
      return run;
    }),
  );

  r.get(
    "/arena/runs/:id/genomes",
    handle({ params: Id, query: GenomesQuery, response: GenomeRows }, async ({ params, query }) => {
      if (
        !(await deps
          .prisma()
          .arenaRun.findUnique({ where: { id: params.id }, select: { id: true } }))
      ) {
        throw new HttpError(404, "RUN_NOT_FOUND", `Arena run ${params.id} not found`);
      }
      return listGenomeRows(deps.prisma(), params.id, { gen: query.gen, family: query.family });
    }),
  );

  r.get(
    "/arena/genomes/:id",
    handle({ params: Id, response: GenomeLineage }, async ({ params }) => {
      const db = deps.prisma();
      const genome = await getGenome(db, params.id);
      if (!genome) throw new HttpError(404, "GENOME_NOT_FOUND", `Genome ${params.id} not found`);
      return {
        genome,
        parents: await getGenomes(db, genome.parentIds),
        trials: await getTrialsForGenome(db, genome.id),
      };
    }),
  );

  // Queued jobs check the status before doing anything, so STOPPED drains the queue harmlessly.
  r.post(
    "/arena/runs/:id/stop",
    handle({ params: Id, response: OkResponse }, async ({ params }) => {
      if (
        !(await deps
          .prisma()
          .arenaRun.findUnique({ where: { id: params.id }, select: { id: true } }))
      ) {
        throw new HttpError(404, "RUN_NOT_FOUND", `Arena run ${params.id} not found`);
      }
      await endRun(jobDeps(), params.id, "STOPPED", "stopped via API");
      return { ok: true as const };
    }),
  );

  return r;
}
