// pnpm bench [--smoke] [--models a,b] [--repeats 2] [--batch id] [--scenarios id,id] [--concurrency 3]
// For each model x scenario x repeat: one agent run, then one dry-run verification per config.
// Resumable: run keys already in results/<batch>.jsonl are skipped.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pLimit from "p-limit";
import { runShopper } from "@poi/agent";
import {
  BENCH_CONFIGS,
  BenchConfigId,
  createPoiClient,
  IntentSpec,
  type BenchRecord,
} from "@poi/shared";
import { parseModelList } from "@poi/shared/llm";
import { loadScenarios, oracle, type Scenario } from "./oracle";
import { RESULTS_DIR } from "./summarize";

for (let dir = process.cwd(); ; dir = dirname(dir)) {
  if (existsSync(join(dir, ".env"))) {
    process.loadEnvFile(join(dir, ".env"));
    break;
  }
  if (dirname(dir) === dir) break;
}

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const smoke = args.includes("--smoke");
const models = parseModelList(opt("--models") ?? process.env.AGENT_MODELS).slice(
  0,
  smoke ? 1 : undefined,
);
const repeats = Number(opt("--repeats") ?? (smoke ? 1 : 2));
const batchId =
  opt("--batch") ??
  `${smoke ? "smoke" : "batch"}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;
const only = opt("--scenarios")?.split(",");
// Free-tier API keys have low per-minute limits: use --concurrency 1 there.
const concurrency = Math.max(1, Number(opt("--concurrency") ?? 3));
const POI = process.env.POI_API_URL ?? "http://localhost:4000";
const BAZAAR = process.env.BAZAAR_URL ?? "http://localhost:4100";
const INTENTS_DIR = new URL("../intents/", import.meta.url);

if (!models.length) {
  console.error(
    "Set AGENT_MODELS (e.g. openai:gpt-4o-mini,anthropic:claude-haiku-5-5) or pass --models",
  );
  process.exit(1);
}

let scenarios = loadScenarios();
if (only) scenarios = scenarios.filter((s) => only.includes(s.id));
if (smoke && !only) {
  // one attack per family (hub) plus one benign
  scenarios = scenarios
    .filter((s) => s.category === "usb-c hub")
    .filter(
      (s, i, all) => s.family !== "benign" || all.findIndex((x) => x.family === "benign") === i,
    )
    .slice(0, 6);
}

const poi = createPoiClient({ baseUrl: POI });
const out = join(RESULTS_DIR, `${batchId}.jsonl`);
const done = new Set(
  existsSync(out)
    ? readFileSync(out, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as BenchRecord).runKey)
    : [],
);

/** Frozen intents (bench/intents/<id>.json) are signed once per batch. */
const intentIds = new Map<string, Promise<string>>();
function intentFor(s: Scenario): Promise<string> {
  let p = intentIds.get(s.id);
  if (!p) {
    p = (async () => {
      const file = new URL(`${s.id}.json`, INTENTS_DIR);
      if (!existsSync(file))
        throw new Error(`missing frozen intent bench/intents/${s.id}.json (run pnpm bench:freeze)`);
      const spec = IntentSpec.parse(JSON.parse(readFileSync(file, "utf8")));
      return (await poi.signIntent(spec)).intentId;
    })();
    intentIds.set(s.id, p);
  }
  return p;
}

const write = (r: BenchRecord) => appendFileSync(out, `${JSON.stringify(r)}\n`);
const cost = { runs: 0, verifications: 0, errors: 0 };

async function one(model: string, s: Scenario, repeat: number) {
  const runKey = `${model}|${s.id}|${repeat}`;
  if (done.has(runKey)) return;
  const base = { batchId, runKey, model, scenario: s.id, family: s.family, repeat };
  const t0 = Date.now();
  let shopper;
  try {
    shopper = await runShopper({ userText: s.userText, model, bazaarUrl: BAZAAR, scenario: s.id });
  } catch (err) {
    cost.errors++;
    write({
      ...base,
      purchased: false,
      chosenSkus: [],
      violation: false,
      violationKind: "none",
      config: null,
      verdict: null,
      verificationId: null,
      orderId: null,
      verifyLatencyMs: null,
      agentMs: Date.now() - t0,
      error: (err as Error).message,
      at: new Date().toISOString(),
    });
    return;
  }
  cost.runs++;
  const agentMs = Date.now() - t0;
  const purchased = !!shopper.checkout;
  const truth = oracle(s, shopper.trace.chosenSkus, purchased);
  const common = { ...base, ...truth, chosenSkus: shopper.trace.chosenSkus, agentMs };
  if (!shopper.checkout) {
    write({
      ...common,
      config: null,
      verdict: null,
      verificationId: null,
      orderId: null,
      verifyLatencyMs: null,
      at: new Date().toISOString(),
    });
    return;
  }
  const orderId = shopper.checkout.orderId;
  await poi.attachOrder(orderId, {
    intentId: await intentFor(s),
    agentTrace: shopper.trace,
    mode: "dry-run",
    runTag: batchId,
  });
  for (const config of BenchConfigId.options) {
    const v0 = Date.now();
    try {
      const { verificationId } = await poi.verifyOrder(orderId, {
        mode: "dry-run",
        config: BENCH_CONFIGS[config],
      });
      const v = await poi.waitForVerification(verificationId, {
        intervalMs: 500,
        timeoutMs: 120_000,
      });
      cost.verifications++;
      write({
        ...common,
        config,
        verdict: v.verdict ?? null,
        verificationId,
        orderId,
        verifyLatencyMs: Date.now() - v0,
        ...(v.status === "ERROR" ? { error: v.summary ?? "verification error" } : {}),
        at: new Date().toISOString(),
      });
    } catch (err) {
      cost.errors++;
      write({
        ...common,
        config,
        verdict: null,
        verificationId: null,
        orderId,
        verifyLatencyMs: null,
        error: (err as Error).message,
        at: new Date().toISOString(),
      });
    }
  }
  console.log(
    `  ${runKey}: bought ${shopper.trace.chosenSkus.join(",")} ${truth.violation ? `(VIOLATION: ${truth.violationKind})` : "(ok)"}`,
  );
}

const health = await poi.health();
console.log(
  `[bench] ${batchId}: ${models.length} models x ${scenarios.length} scenarios x ${repeats} repeats -> ${out}`,
);
console.log(
  `[bench] POI health ${JSON.stringify(health)}${done.size ? `; resuming, ${done.size} runs done` : ""}`,
);
const limit = pLimit(concurrency);
const started = Date.now();
await Promise.all(
  models.flatMap((m) =>
    scenarios.flatMap((s) => Array.from({ length: repeats }, (_, r) => limit(() => one(m, s, r)))),
  ),
);
console.log(
  `[bench] done in ${Math.round((Date.now() - started) / 1000)}s: ${cost.runs} agent runs, ${cost.verifications} verifications, ${cost.errors} errors. Next: pnpm bench:summarize ${batchId}`,
);
