// How arena jobs run (CONTRACTS-L2 4.3).
//   BullMQ: "propose" on arena.generation persists genomes, then adds a FlowProducer flow whose
//   parent is the generation's "finalize" job and whose children are the trials on arena.trial.
//   BullMQ runs the parent only after every child has finished, so finalize sees all trials.
//   Inline (no Redis: tests, local dev): the same steps in-process with a concurrency limit.
// Job ids are deterministic so a retry never duplicates work. BullMQ rejects ids with one or two
// colons, so the ids use dashes: {runId}-g{gen}, {runId}-g{gen}-final, trial = genome id.
import { FlowProducer, Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { endRun, finalizeGeneration, proposeGeneration, type ArenaJobDeps } from "./jobs";
import { runTrial, type ArenaTrialDeps } from "./trial.job";

export const GENERATION_QUEUE = "arena.generation";
export const TRIAL_QUEUE = "arena.trial";

export interface ArenaQueue {
  enqueueGeneration(runId: string, generation: number): Promise<void>;
  close(): Promise<void>;
}

const generationJobId = (runId: string, generation: number) => `${runId}-g${generation}`;

type JobDepsWithoutQueue = Omit<ArenaJobDeps & ArenaTrialDeps, "enqueueGeneration">;

/** A run that crashes outside the budget path ends as ERROR rather than hanging in RUNNING. */
async function failRun(deps: JobDepsWithoutQueue, runId: string, err: unknown) {
  deps.logger.error({ runId, err: (err as Error).message }, "arena job failed");
  await endRun(
    { ...deps, enqueueGeneration: async () => {} },
    runId,
    "ERROR",
    (err as Error).message,
  ).catch(() => {});
}

// --- inline --------------------------------------------------------------------------------

async function pool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
      for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x);
    }),
  );
}

export function createInlineArenaQueue(deps: JobDepsWithoutQueue, concurrency: number): ArenaQueue {
  const inflight = new Set<Promise<void>>();
  const queue: ArenaQueue = {
    async enqueueGeneration(runId, generation) {
      const p = (async () => {
        const jobDeps: ArenaJobDeps & ArenaTrialDeps = {
          ...deps,
          enqueueGeneration: queue.enqueueGeneration,
        };
        try {
          const ids = await proposeGeneration(jobDeps, runId, generation);
          if (!ids.length) return;
          await pool(ids, concurrency, async (id) => {
            try {
              await runTrial(jobDeps, runId, id);
            } catch (err) {
              // Like ignoreDependencyOnFailure: one broken trial doesn't block the generation.
              deps.logger.warn(
                { runId, genomeId: id, err: (err as Error).message },
                "arena trial failed",
              );
            }
          });
          await finalizeGeneration(jobDeps, runId, generation);
        } catch (err) {
          await failRun(deps, runId, err);
        }
      })();
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    },
    async close() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
  };
  return queue;
}

// --- BullMQ --------------------------------------------------------------------------------

const connection = (url: string) => {
  const r = new Redis(url, { maxRetriesPerRequest: null });
  r.on("error", () => {});
  return r;
};

export function createBullArenaQueue(redisUrl: string): ArenaQueue {
  const conn = connection(redisUrl);
  const generations = new Queue(GENERATION_QUEUE, { connection: conn });
  return {
    async enqueueGeneration(runId, generation) {
      await generations.add(
        "propose",
        { runId, generation },
        {
          jobId: generationJobId(runId, generation),
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: 500,
          removeOnFail: 500,
        },
      );
    },
    async close() {
      await generations.close();
      conn.disconnect();
    },
  };
}

/** Workers for both arena queues. Run in the API (WORKER_INLINE) or in dist/worker.js. */
export function startArenaWorkers(
  redisUrl: string,
  deps: JobDepsWithoutQueue,
  concurrency: number,
) {
  const queue = createBullArenaQueue(redisUrl);
  const jobDeps: ArenaJobDeps & ArenaTrialDeps = {
    ...deps,
    enqueueGeneration: queue.enqueueGeneration,
  };
  const flowConn = connection(redisUrl);
  const flows = new FlowProducer({ connection: flowConn });
  const genConn = connection(redisUrl);
  const trialConn = connection(redisUrl);

  const generationWorker = new Worker<{ runId: string; generation: number }>(
    GENERATION_QUEUE,
    async (job) => {
      const { runId, generation } = job.data;
      if (job.name === "finalize") return finalizeGeneration(jobDeps, runId, generation);
      const ids = await proposeGeneration(jobDeps, runId, generation);
      if (!ids.length) return;
      await flows.add({
        name: "finalize",
        queueName: GENERATION_QUEUE,
        data: { runId, generation },
        opts: {
          jobId: `${generationJobId(runId, generation)}-final`,
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
        },
        children: ids.map((genomeId) => ({
          name: "trial",
          queueName: TRIAL_QUEUE,
          data: { runId, genomeId },
          // A trial that fails all its attempts must not block the generation forever.
          opts: {
            jobId: genomeId,
            attempts: 2,
            backoff: { type: "exponential", delay: 2000 },
            ignoreDependencyOnFailure: true,
          },
        })),
      });
    },
    { connection: genConn, concurrency: 2 },
  );
  generationWorker.on("failed", (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1))
      void failRun(deps, job.data.runId, err);
  });

  const trialWorker = new Worker<{ runId: string; genomeId: string }>(
    TRIAL_QUEUE,
    async (job) => {
      await runTrial(jobDeps, job.data.runId, job.data.genomeId);
    },
    { connection: trialConn, concurrency },
  );
  for (const w of [generationWorker, trialWorker]) w.on("error", () => {});

  return {
    queue,
    async close() {
      await Promise.allSettled([
        generationWorker.close(),
        trialWorker.close(),
        flows.close(),
        queue.close(),
      ]);
      for (const c of [flowConn, genConn, trialConn]) c.disconnect();
    },
  };
}
