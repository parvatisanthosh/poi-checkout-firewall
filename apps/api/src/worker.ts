import { env } from "./env";

// P7 replaces this with the BullMQ "verify" worker.
console.log(`[worker] skeleton -- no queue yet (concurrency will be ${env.VERIFY_CONCURRENCY})`);
