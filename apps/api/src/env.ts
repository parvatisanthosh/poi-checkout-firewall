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
  API_PORT: z.coerce.number().int().default(4000),
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
});

export type Env = z.infer<typeof Env>;
export const env: Env = Env.parse(process.env);
