// The "verify" job queue. BullMQ when Redis is available (job id = verificationId, so a
// duplicate enqueue is a no-op; 2 retries with backoff for PayPal/LLM blips). Without Redis, an
// in-process queue with the same retry policy so `pnpm dev` and tests work.
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

export const VERIFY_QUEUE = "verify";
export const ATTEMPTS = 3; // first try + 2 retries
const BACKOFF_MS = 2000;

export interface VerifyQueue {
  enqueue(verificationId: string): Promise<void>;
  close(): Promise<void>;
}

export type RunFn = (verificationId: string) => Promise<void>;
export type FailFn = (verificationId: string, err: unknown) => Promise<void>;

const bullConnection = (url: string) => {
  const r = new Redis(url, { maxRetriesPerRequest: null });
  r.on("error", () => {});
  return r;
};

export function createBullQueue(redisUrl: string): VerifyQueue {
  const connection = bullConnection(redisUrl);
  const queue = new Queue(VERIFY_QUEUE, { connection });
  return {
    async enqueue(verificationId) {
      await queue.add(
        VERIFY_QUEUE,
        { verificationId },
        {
          jobId: verificationId,
          attempts: ATTEMPTS,
          backoff: { type: "exponential", delay: BACKOFF_MS },
          removeOnComplete: 1000,
          removeOnFail: 1000,
        },
      );
    },
    async close() {
      await queue.close();
      connection.disconnect();
    },
  };
}

export function startBullWorker(
  redisUrl: string,
  run: RunFn,
  onFailed: FailFn,
  concurrency: number,
) {
  const connection = bullConnection(redisUrl);
  const worker = new Worker<{ verificationId: string }>(
    VERIFY_QUEUE,
    async (job) => run(job.data.verificationId),
    {
      connection,
      concurrency,
    },
  );
  worker.on("failed", (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1))
      void onFailed(job.data.verificationId, err);
  });
  worker.on("error", () => {});
  return {
    async close() {
      await worker.close();
      connection.disconnect();
    },
  };
}

export function createInlineQueue(
  run: RunFn,
  onFailed: FailFn,
  backoffMs = BACKOFF_MS,
): VerifyQueue {
  const inflight = new Map<string, Promise<void>>();
  return {
    async enqueue(verificationId) {
      if (inflight.has(verificationId)) return;
      const p = (async () => {
        for (let attempt = 1; ; attempt++) {
          try {
            await run(verificationId);
            return;
          } catch (err) {
            if (attempt >= ATTEMPTS) return onFailed(verificationId, err);
            await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
          }
        }
      })().finally(() => inflight.delete(verificationId));
      inflight.set(verificationId, p);
    },
    async close() {
      await Promise.allSettled(inflight.values());
    },
  };
}
