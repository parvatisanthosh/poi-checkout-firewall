import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BenchSummary } from "@poi/shared";
import { hasKeyFor, parseModelList } from "@poi/shared/llm";

export const BAZAAR_URL = process.env.BAZAAR_URL ?? "http://localhost:4100";

/** AGENT_MODELS with whether this server has the provider key. */
export function agentModels(): Array<{ id: string; available: boolean }> {
  try {
    return parseModelList(process.env.AGENT_MODELS).map((id) => ({ id, available: hasKeyFor(id) }));
  } catch {
    return [];
  }
}

/** bench/results/summary.json, if a benchmark has been run and summarized. */
export function readBenchSummary(): BenchSummary | null {
  const candidates = [
    join(process.cwd(), "..", "..", "bench", "results", "summary.json"),
    join(process.cwd(), "bench", "results", "summary.json"),
  ];
  const file = candidates.find((f) => existsSync(f));
  if (!file) return null;
  const parsed = BenchSummary.safeParse(JSON.parse(readFileSync(file, "utf8")));
  return parsed.success ? parsed.data : null;
}
