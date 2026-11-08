import type { HealthResponse } from "@poi/shared";

export interface HealthChecks {
  db: () => Promise<unknown>;
  redis: () => Promise<unknown>;
  /** Undefined when PayPal credentials are not configured. */
  paypal?: () => Promise<unknown>;
}

async function probe(
  fn: (() => Promise<unknown>) | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (!fn) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the three probes in parallel, each capped at `timeoutMs`. ok = all green. */
export async function checkHealth(checks: HealthChecks, timeoutMs = 2000): Promise<HealthResponse> {
  const [db, redis, paypal] = await Promise.all([
    probe(checks.db, timeoutMs),
    probe(checks.redis, timeoutMs),
    probe(checks.paypal, timeoutMs),
  ]);
  return { ok: db && redis && paypal, db, redis, paypal };
}
