// How immune jobs run (CONTRACTS-L2 4.3): immune.mint (job id mint-{orderId}) then
// immune.promote (promote-{antibodyId}). BullMQ when Redis is set; otherwise in-process, one job
// at a time (minting and promotion both read-then-write the antibody table, so serial is simplest
// and plenty fast). Ids use dashes: BullMQ rejects custom ids with one or two colons.
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { mintAntibody, type ImmuneJobDeps, type MintJob } from "./mint.job";
import { promoteAntibody, type PromoteDeps } from "./promote.job";

export const MINT_QUEUE = "immune.mint";
export const PROMOTE_QUEUE = "immune.promote";

export interface ImmuneQueue {
  enqueueMint(job: MintJob): Promise<void>;
  enqueuePromote(antibodyId: string): Promise<void>;
  close(): Promise<void>;
}

export type ImmuneWorkerDeps = Omit<ImmuneJobDeps, "enqueuePromote"> & PromoteDeps;

const safeId = (s: string) => s.replace(/:/g, "_");

// --- inline --------------------------------------------------------------------------------

export function createInlineImmuneQueue(deps: ImmuneWorkerDeps): ImmuneQueue {
  let chain: Promise<void> = Promise.resolve();
  const seen = new Set<string>();
  const run = (id: string, fn: () => Promise<unknown>) => {
    if (seen.has(id)) return Promise.resolve(); // same job id = same job, like BullMQ
    seen.add(id);
    chain = chain.then(async () => {
      try {
        await fn();
      } catch (err) {
        deps.logger.error({ job: id, err: (err as Error).message }, "immune job failed");
      }
    });
    return Promise.resolve();
  };
  const queue: ImmuneQueue = {
    enqueueMint: (job) =>
      run(`mint-${job.orderId}`, () =>
        mintAntibody({ ...deps, enqueuePromote: queue.enqueuePromote }, job),
      ),
    enqueuePromote: (id) => run(`promote-${id}`, () => promoteAntibody(deps, id)),
    async close() {
      // Jobs enqueue further jobs; wait until the chain stops growing.
      for (let last: Promise<void> | undefined; last !== chain;) {
        last = chain;
        await chain;
      }
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

const jobOpts = (jobId: string) => ({
  jobId,
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
});

export function createBullImmuneQueue(redisUrl: string): ImmuneQueue {
  const conn = connection(redisUrl);
  const mint = new Queue(MINT_QUEUE, { connection: conn });
  const promote = new Queue(PROMOTE_QUEUE, { connection: conn });
  return {
    async enqueueMint(job) {
      await mint.add("mint", job, jobOpts(safeId(`mint-${job.orderId}`)));
    },
    async enqueuePromote(id) {
      await promote.add("promote", { antibodyId: id }, jobOpts(safeId(`promote-${id}`)));
    },
    async close() {
      await Promise.allSettled([mint.close(), promote.close()]);
      conn.disconnect();
    },
  };
}

/** Workers for both immune queues. Promotion runs one at a time (it bumps the defender version). */
export function startImmuneWorkers(redisUrl: string, deps: ImmuneWorkerDeps) {
  const queue = createBullImmuneQueue(redisUrl);
  const mintConn = connection(redisUrl);
  const promoteConn = connection(redisUrl);
  const mintWorker = new Worker<MintJob>(
    MINT_QUEUE,
    async (job) => {
      await mintAntibody({ ...deps, enqueuePromote: queue.enqueuePromote }, job.data);
    },
    { connection: mintConn, concurrency: 2 },
  );
  const promoteWorker = new Worker<{ antibodyId: string }>(
    PROMOTE_QUEUE,
    async (job) => {
      await promoteAntibody(deps, job.data.antibodyId);
    },
    { connection: promoteConn, concurrency: 1 },
  );
  for (const w of [mintWorker, promoteWorker]) w.on("error", () => {});
  return {
    queue,
    async close() {
      await Promise.allSettled([mintWorker.close(), promoteWorker.close(), queue.close()]);
      for (const c of [mintConn, promoteConn]) c.disconnect();
    },
  };
}
