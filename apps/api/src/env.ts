import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "dotenv";
import { z } from "zod";

/** Find the repo-root .env by walking up from cwd (works for tsx, dist and turbo). */
function findEnvFile(start = process.cwd()): string | undefined {
  let dir = start;
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const envPath = findEnvFile();
if (envPath) config({ path: envPath, quiet: true });

// P0: everything optional so the skeleton boots with an empty .env.
// Later tasks tighten the variables they need (P1 PayPal, P2 DB/Redis, P3 signing key).
const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Hosts like Render assign PORT; API_PORT wins when both are set.
  API_PORT: z.coerce
    .number()
    .int()
    .default(Number(process.env.PORT ?? 4000)),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_BASE_URL: z.string().default("https://api-m.sandbox.paypal.com"),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  POI_SIGNING_JWK: z.string().optional(),
  COMPILER_MODEL: z.string().optional(),
  JUDGE_MODEL: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  BAZAAR_URL: z.string().default("http://localhost:4100"),
  VERIFY_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // "true": the API also runs the verify worker (one process; Render free tier). "false": run
  // dist/worker.js separately (BullMQ + Socket.IO redis adapter carry jobs and events between them).
  WORKER_INLINE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // --- Layer 2 (docs/CONTRACTS-L2.md 4.8) ---
  /**
   * Live authorizations (POST /orders/:id/authorize, MCP capture_if_verified) also run the immune
   * stage and the conformal gate. Off by default: Layer 1 behaviour is unchanged unless enabled.
   */
  LIVE_LAYER2: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * With WORKER_INLINE, the API also runs the arena + immune workers. Set false when the dedicated
   * poi-arena-worker (dist/arena-worker.js) is deployed, so only it takes those jobs.
   */
  ARENA_WORKERS_INLINE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** "real" = @poi/arena (LLM attacker); "fake" = no-LLM stand-in for demos and offline work. */
  ARENA_ENGINE: z.enum(["real", "fake"]).default("real"),
  ARENA_ATTACKER_MODEL: z.string().optional(),
  ARENA_HELDOUT_ATTACKER_MODEL: z.string().optional(),
  ARENA_AGENT_MODEL: z.string().optional(),
  ARENA_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /** Hard ceiling per run; a run's own maxUsd can only be lower. */
  ARENA_MAX_USD: z.coerce.number().positive().default(15),
  /** Optional JSON price overrides: {"provider:model": {"in": usdPer1M, "out": usdPer1M}}. */
  ARENA_PRICES: z.string().optional(),
  /** Immune memory: MinHash (estimated Jaccard) and embedding (cosine) match thresholds. */
  IMMUNE_JACCARD: z.coerce.number().min(0).max(1).default(0.5),
  IMMUNE_COSINE: z.coerce.number().min(0).max(1).default(0.85),
  /** The promotion gate's benign set (repo-relative or absolute). */
  IMMUNE_BENIGN_SET: z.string().default("bench/evolved/benign-40.json"),
  /** Merchant risk above this raises the verdict to ASK_HUMAN. */
  RISK_ASK_THRESHOLD: z.coerce.number().min(0).max(1).default(0.35),
  /** Conformal gate: default alpha, and the benign quantile that sets lambdaVoid. */
  CRC_ALPHA: z.coerce.number().gt(0).lt(1).default(0.05),
  CRC_BENIGN_VOID_QUANTILE: z.coerce.number().gt(0).max(1).default(0.99),
});

export type Env = z.infer<typeof Env>;
export const env: Env = Env.parse(process.env);
