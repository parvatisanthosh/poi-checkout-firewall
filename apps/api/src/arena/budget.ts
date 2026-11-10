// The arena's budget guard (CONTRACTS-L2: "every LLM call goes through withBudget"). It runs a job
// inside a usage context: every metered model call (getModel from @poi/shared/llm -- the agent,
// the judge and @poi/arena all use it) reports its tokens here, is priced, and is added to
// ArenaRun.costUsd with an atomic increment. Past the run's limit the NEXT call throws
// BudgetExceeded, so parallel trials can't overshoot by more than the calls already in flight.
import { withUsageSink, type ModelUsage } from "@poi/shared/llm";
import { z } from "zod";
import { env } from "../env";
import type { Prisma, PrismaClient } from "../lib/prisma";
import { addRunCost } from "./archive.repo";

export class BudgetExceeded extends Error {
  override readonly name = "BudgetExceeded";
  constructor(
    readonly runId: string,
    readonly costUsd: number,
    readonly maxUsd: number,
  ) {
    super(`arena run ${runId} spent $${costUsd.toFixed(4)}, over its $${maxUsd} budget`);
  }
}

/** True for a BudgetExceeded, even when an SDK wrapped it as an error cause. */
export function isBudgetExceeded(err: unknown): err is BudgetExceeded {
  for (
    let e: unknown = err, depth = 0;
    e && depth < 5;
    e = (e as { cause?: unknown }).cause, depth++
  ) {
    if (e instanceof BudgetExceeded || (e as Error).name === "BudgetExceeded") return true;
  }
  return false;
}

export interface Price {
  /** USD per 1M input tokens */
  in: number;
  /** USD per 1M output tokens */
  out: number;
}

/**
 * List prices (USD per 1M tokens). Free-tier keys cost nothing in cash, but the guard still meters
 * them at list price so a runaway loop stops instead of burning the free quota overnight.
 * Unknown models fall back to a deliberately high default. Override with ARENA_PRICES.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  "google:gemini-flash-lite-latest": { in: 0.1, out: 0.4 },
  "google:gemini-flash-latest": { in: 0.3, out: 2.5 },
  "groq:openai/gpt-oss-120b": { in: 0.15, out: 0.6 },
  "groq:openai/gpt-oss-20b": { in: 0.075, out: 0.3 },
  "groq:qwen/qwen3.8-27b": { in: 0.3, out: 0.6 },
  "openai:gpt-4o-mini": { in: 0.15, out: 0.6 },
};
export const FALLBACK_PRICE: Price = { in: 1, out: 3 };

const PriceOverrides = z.record(
  z.string(),
  z.object({ in: z.number().nonnegative(), out: z.number().nonnegative() }),
);

export function priceTable(overridesJson = env.ARENA_PRICES): Record<string, Price> {
  if (!overridesJson) return DEFAULT_PRICES;
  return { ...DEFAULT_PRICES, ...PriceOverrides.parse(JSON.parse(overridesJson)) };
}

export function costOf(u: ModelUsage, prices: Record<string, Price> = DEFAULT_PRICES): number {
  const p = prices[u.modelId] ?? FALLBACK_PRICE;
  return (u.inputTokens * p.in + u.outputTokens * p.out) / 1_000_000;
}

export interface BudgetContext {
  db: PrismaClient | Prisma.TransactionClient;
  runId: string;
  /** The run's limit; capped by ARENA_MAX_USD. */
  maxUsd: number;
  prices?: Record<string, Price>;
  /** Called after every charged call (e.g. to emit arena:run with the new cost). */
  onCharge?: (costUsd: number) => void;
}

export const effectiveMaxUsd = (runMaxUsd: number) => Math.min(runMaxUsd, env.ARENA_MAX_USD);

/**
 * Run `fn` with every metered LLM call inside it charged to the run. Throws BudgetExceeded before
 * starting if the run is already over, and from the first call that takes it over.
 */
export async function withBudget<T>(ctx: BudgetContext, fn: () => Promise<T>): Promise<T> {
  const prices = ctx.prices ?? priceTable();
  const run = await ctx.db.arenaRun.findUnique({
    where: { id: ctx.runId },
    select: { costUsd: true },
  });
  if (!run) throw new Error(`arena run ${ctx.runId} not found`);
  if (run.costUsd >= ctx.maxUsd) throw new BudgetExceeded(ctx.runId, run.costUsd, ctx.maxUsd);
  return withUsageSink(async (u) => {
    const total = await addRunCost(ctx.db, ctx.runId, costOf(u, prices));
    ctx.onCharge?.(total);
    if (total > ctx.maxUsd) throw new BudgetExceeded(ctx.runId, total, ctx.maxUsd);
  }, fn);
}
