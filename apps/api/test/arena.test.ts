// Arena: budget metering (Q2), then the loop end to end with the real trial (Q3).
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ArenaRunConfig, createPoiClient, type ArenaEngine, type AttackFamily } from "@poi/shared";
import { fakeProposeGeneration } from "@poi/shared/arena-fake";
import { meterModel, withUsageSink, type ModelUsage } from "@poi/shared/llm";
import { arenaJobDeps, buildDeps, createApp, type AppDeps } from "../src/app";
import {
  createRun,
  getCells,
  getTrialsForGeneration,
  insertGenome,
  setRunStatus,
} from "../src/arena/archive.repo";
import {
  BudgetExceeded,
  costOf,
  DEFAULT_PRICES,
  FALLBACK_PRICE,
  isBudgetExceeded,
  priceTable,
} from "../src/arena/budget";
import { arenaEngine } from "@poi/arena";
import { fakeEngine, selectArenaEngine } from "../src/arena/engine";
import {
  createBullArenaQueue,
  createInlineArenaQueue,
  startArenaWorkers,
} from "../src/arena/queue";
import { isTransient, runTrial, tenantId, tenantTerms } from "../src/arena/trial.job";
import { parseChecks } from "../src/lib/mappers";
import { loadSigningKey } from "../src/evidence/keys";
import { BazaarHttpError } from "../src/lib/bazaar";
import { disconnectPrisma, getPrisma } from "../src/lib/prisma";
import { PayPalError } from "../src/paypal";
import type { ArenaEmitter } from "../src/realtime/arena-emitter";
import { arenaFakes, bazaarData, scenarios } from "./arena-fakes";
import { testSigningKey } from "./helpers";
import { preserveMerchantRisk } from "./risk-guard";

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});
const mockModel = (input: number, output: number) =>
  new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: usage(input, output),
      warnings: [],
    },
  });

describe("budget pricing and metering", () => {
  it("prices usage per model, with overrides and a conservative fallback", () => {
    expect(
      costOf({
        modelId: "google:gemini-flash-lite-latest",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBeCloseTo(0.5);
    expect(costOf({ modelId: "nope:unknown", inputTokens: 1_000_000, outputTokens: 0 })).toBe(
      FALLBACK_PRICE.in,
    );
    const t = priceTable('{"nope:unknown":{"in":0,"out":0}}');
    expect(t["nope:unknown"]).toEqual({ in: 0, out: 0 });
    expect(t["groq:openai/gpt-oss-120b"]).toEqual(DEFAULT_PRICES["groq:openai/gpt-oss-120b"]);
  });

  it("metered models report usage only inside a usage context", async () => {
    const seen: ModelUsage[] = [];
    const model = meterModel(mockModel(120, 30), "groq:openai/gpt-oss-120b");
    await generateText({ model, prompt: "hi" }); // outside: nothing recorded
    await withUsageSink(
      (u) => void seen.push(u),
      () => generateText({ model, prompt: "hi" }),
    );
    expect(seen).toEqual([
      { modelId: "groq:openai/gpt-oss-120b", inputTokens: 120, outputTokens: 30 },
    ]);
  });

  it("a sink that throws BudgetExceeded aborts the LLM call that crossed the line", async () => {
    const model = meterModel(mockModel(10, 10), "x:y");
    const err = await withUsageSink(
      () => {
        throw new BudgetExceeded("run1", 2, 1);
      },
      () => generateText({ model, prompt: "hi" }),
    ).catch((e: unknown) => e);
    expect(isBudgetExceeded(err)).toBe(true);
    expect(isBudgetExceeded(new Error("wrapped", { cause: new BudgetExceeded("r", 1, 0) }))).toBe(
      true,
    );
    expect(isBudgetExceeded(new Error("other"))).toBe(false);
  });
});

describe("engine selection", () => {
  it("ARENA_ENGINE picks @poi/arena (real) or the no-LLM stand-in (fake)", () => {
    expect(selectArenaEngine("real")).toBe(arenaEngine);
    expect(selectArenaEngine("fake")).toBe(fakeEngine);
  });
});

describe("tenant terms", () => {
  const listing = { merchantId: "orbitek", termsExcerpt: " Renews at $9.99/month. " };
  it("adds the evolved excerpt only for an order to the evolved listing's merchant", () => {
    expect(tenantTerms("orbitek", { listing } as never, "arena-g0-x")).toEqual([
      { id: "arena:arena-g0-x:terms", text: "Renews at $9.99/month." },
    ]);
    expect(tenantTerms("voltra-official", { listing } as never, "t")).toEqual([]);
    expect(tenantTerms(null, { listing } as never, "t")).toEqual([]);
    expect(tenantTerms("orbitek", { listing: { merchantId: "orbitek" } } as never, "t")).toEqual(
      [],
    );
  });
});

describe("transient-error classification", () => {
  it("retries 429/5xx and network failures, never budget or 4xx", () => {
    expect(isTransient(Object.assign(new Error("x"), { statusCode: 429 }))).toBe(true);
    expect(isTransient(Object.assign(new Error("x"), { statusCode: 400 }))).toBe(false);
    expect(isTransient(new PayPalError(503, "UNAVAILABLE", "x"))).toBe(true);
    expect(isTransient(new PayPalError(422, "UNPROCESSABLE", "x"))).toBe(false);
    expect(isTransient(new BazaarHttpError(502, "x"))).toBe(true);
    expect(isTransient(new BazaarHttpError(404, "x"))).toBe(false);
    expect(isTransient(new TypeError("fetch failed"))).toBe(true);
    expect(isTransient(new BudgetExceeded("r", 2, 1))).toBe(false);
    expect(isTransient(new Error("wrapped", { cause: new BazaarHttpError(500, "x") }))).toBe(true);
    expect(isTransient(new Error("plain"))).toBe(false);
  });
});

// --- end to end: the real trial between fake edges (Postgres; the BullMQ case also needs Redis) --
// Fakes stand in for the Bazaar tenant service, the shopping agent and PayPal (arena-fakes.ts).
// Everything else is real: intents, attach, both verifier arms, oracle, fitness, archive, events.

type Ev = { type: string; payload: { runId?: string; status?: string; generation?: number } };
function recorder(): ArenaEmitter & { events: Ev[] } {
  const events: Ev[] = [];
  const push = (type: string) => (payload: object) =>
    void events.push({ type, payload: payload as Ev["payload"] });
  return {
    events,
    run: push("run"),
    trial: push("trial"),
    generation: push("generation"),
    minted: push("minted"),
    promoted: push("promoted"),
    rejected: push("rejected"),
    calibration: push("calibration"),
  };
}

describe.runIf(process.env.RUN_DB_TESTS === "1")("arena with the real trial (real DB)", () => {
  const db = getPrisma();
  const runIds: string[] = [];
  const emitter = recorder();
  const fakes = arenaFakes();
  const mints: Array<{ orderId: string; family: string }> = [];
  let deps: AppDeps;
  let baseUrl = "";
  let server: ReturnType<typeof createServer>;
  let restoreRisk: () => Promise<void> = async () => {};

  beforeAll(async () => {
    // Prefer the real key so evidence rows in a dev DB keep valid signatures; CI has none.
    const key = process.env.POI_SIGNING_JWK
      ? await loadSigningKey(process.env.POI_SIGNING_JWK)
      : await testSigningKey();
    for (const m of bazaarData.merchants)
      await db.merchant.upsert({ where: { id: m.id }, create: m, update: m });
    // trials count arena orders and reports against the demo sellers' arena risk rows
    restoreRisk = await preserveMerchantRisk(
      db,
      bazaarData.merchants.map((m) => `arena:${m.id}`),
    );
    deps = buildDeps({
      paypal: fakes.paypal,
      signingKey: async () => key,
      // no LLMs: rules compiler, deterministic checks only
      compilerModel: undefined,
      judgeModel: undefined,
      injectionModel: undefined,
      embeddingModel: undefined,
      agentModel: () => undefined,
      listingCard: async () => undefined,
      // pinned: the real engine would call the attacker LLM with whatever keys .env holds
      arenaEngine: fakeEngine,
      arenaEmitter: emitter,
      arenaScenarios: async () => scenarios,
      arenaBazaar: fakes.bazaar,
      arenaShop: fakes.shop,
      enqueueMint: async (job) => void mints.push(job),
    });
    deps.arenaQueue = createInlineArenaQueue(arenaJobDeps(deps), 3);
    server = createServer(createApp(deps));
    await new Promise<void>((r) => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    fakes.choose = (_tenant, evolvedSku) => evolvedSku;
    deps.arenaEngine = fakeEngine;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    // Orders, verifications and evidence stay: the evidence chain is append-only.
    for (const runId of runIds) {
      await db.arenaTrial.deleteMany({ where: { genome: { runId } } });
      await db.attackGenome.deleteMany({ where: { runId } });
      await db.arenaCell.deleteMany({ where: { runId } });
      await db.arenaGeneration.deleteMany({ where: { runId } });
      await db.arenaRun.deleteMany({ where: { id: runId } });
    }
    await restoreRisk();
    await disconnectPrisma();
  });

  const config = (over: object = {}) => ({
    attackerModel: "fake:attacker",
    agentModel: "fake:agent",
    families: ["subscription", "injection", "lookalike"] as const,
    generations: 2,
    populationSize: 4,
    ...over,
  });

  it("1 generation x 4 genomes: real orders, two verdicts each, fitness from the engine", async () => {
    const poi = createPoiClient({ baseUrl });
    deps.arenaQueue = createInlineArenaQueue(arenaJobDeps(deps), 4);
    const { runId } = await poi.startArenaRun({
      ...config(),
      families: [...config().families],
      generations: 1,
    });
    runIds.push(runId);
    await deps.arenaQueue.close();

    const trials = await getTrialsForGeneration(db, runId, 0);
    expect(trials).toHaveLength(4);
    for (const t of trials) {
      expect(t.invalidReasons).toEqual([]);
      expect(t.valid).toBe(true);
      expect(t.orderId).toBeDefined();
      expect(t.verdictStatic).toBeDefined();
      expect(t.verdictImmune).toBeDefined();
      expect(t.scoresStatic).toBeDefined();
      expect(t.chosenPoison).toBe(true); // the fake shopper buys the evolved listing
      expect(t.fitness).toBeCloseTo(
        fakeEngine.scoreFitness({
          valid: true,
          chosenPoison: true,
          verdict: t.verdictStatic,
          stealthP: t.stealthP,
          noveltyCos: t.noveltyCos,
        }),
      );
      expect(t.reported).toBe(t.verdictImmune === "CAPTURE");

      // a real (dry-run) order, tagged with the run, verified under both arms
      const order = await db.orderRecord.findUniqueOrThrow({
        where: { id: t.orderId! },
        include: { verifications: true },
      });
      expect(order).toMatchObject({ mode: "DRY_RUN", runTag: runId });
      expect(order.verifications.map((v) => v.status)).toEqual(["DONE", "DONE"]);
      expect(
        order.verifications.map((v) => (v.config as { immune: boolean }).immune).sort(),
      ).toEqual([false, true]);
    }
    // Fitness makes sense: a caught attack (VOID / ASK_HUMAN) scores below 2, one that fooled
    // the static verifier scores 3 or more.
    for (const t of trials)
      if (t.verdictStatic === "CAPTURE") expect(t.fitness).toBeGreaterThanOrEqual(3);
      else expect(t.fitness).toBeLessThan(2);
    // the hidden subscription line is caught by the deterministic checks alone
    expect(trials.some((t) => t.verdictStatic !== "CAPTURE")).toBe(true);

    // every tenant created was deleted; every captured violation was reported once
    const tenants = (await db.attackGenome.findMany({ where: { runId } }))
      .map((g) => tenantId(g))
      .sort();
    expect(fakes.bazaar.created.filter((x) => tenants.includes(x)).sort()).toEqual(tenants);
    expect(fakes.bazaar.deleted.filter((x) => tenants.includes(x)).sort()).toEqual(tenants);
    expect(mints.filter((m) => trials.some((t) => t.orderId === m.orderId))).toHaveLength(
      trials.filter((t) => t.reported).length,
    );

    const detail = await poi.getArenaRun(runId);
    expect(detail.status).toBe("DONE");
    expect(detail.cells.reduce((s, c) => s + c.attempts, 0)).toBe(4);
    expect(detail.generations[0]?.asrStatic).toBeCloseTo(
      trials.filter((t) => t.verdictStatic === "CAPTURE").length / 4,
    );
  }, 60_000);

  it("POST /api/arena/runs runs 2 generations: events, rows, DONE", async () => {
    const poi = createPoiClient({ baseUrl });
    deps.arenaQueue = createInlineArenaQueue(arenaJobDeps(deps), 3);
    const { runId } = await poi.startArenaRun({ ...config(), families: [...config().families] });
    runIds.push(runId);
    await deps.arenaQueue.close(); // drains every generation the run enqueues

    const mine = emitter.events.filter((e) => e.payload.runId === runId);
    expect(mine.filter((e) => e.type === "trial")).toHaveLength(8);
    expect(mine.filter((e) => e.type === "generation").map((e) => e.payload.generation)).toEqual([
      0, 1,
    ]);
    const statuses = mine.filter((e) => e.type === "run").map((e) => e.payload.status);
    expect(statuses[0]).toBe("RUNNING");
    expect(statuses.at(-1)).toBe("DONE");

    const detail = await poi.getArenaRun(runId);
    expect(detail.status).toBe("DONE");
    expect(detail.generations.map((g) => g.generation)).toEqual([0, 1]);
    expect(detail.cells).toHaveLength(42);
    expect(detail.cells.reduce((s, c) => s + c.attempts, 0)).toBe(8);
    expect((await poi.listArenaRuns()).find((r) => r.id === runId)?.generationsDone).toBe(2);

    const rows = await poi.getArenaGenomes(runId);
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.bestTrial !== null)).toBe(true);
    const gen1 = await poi.getArenaGenomes(runId, { gen: 1 });
    const child = gen1.find((g) => g.parentIds.length > 0);
    expect(child?.operator).toBe("mutate");
    const lineage = await poi.getGenome(child!.id);
    expect(lineage.parents.map((p) => p.id)).toEqual(child!.parentIds);
    expect(lineage.trials).toHaveLength(1);
  }, 60_000);

  // --- single trials, run directly -------------------------------------------------------------

  /** A RUNNING run with one inserted genome, ready for runTrial. */
  async function oneGenome(family: AttackFamily = "subscription") {
    const cfg = ArenaRunConfig.parse({ ...config(), families: [family], generations: 1 });
    const runId = await createRun(db, cfg);
    runIds.push(runId);
    await setRunStatus(db, runId, "RUNNING");
    const [draft] = await fakeProposeGeneration({
      runId,
      generation: 0,
      populationSize: 4,
      archive: [],
      elites: [],
      library: [],
      families: [family],
      scenarios,
      attackerModel: "fake:attacker",
      seed: 7,
    });
    const genome = await insertGenome(db, {
      ...draft!,
      runId,
      generation: 0,
      split: "train",
      attackerModel: "fake:attacker",
    });
    return { runId, genome };
  }
  const trialDeps = () => ({
    ...arenaJobDeps(deps),
    enqueueGeneration: async () => {},
    retryDelayMs: 1,
    rateLimitDelayMs: 1,
  });
  const attempts = async (runId: string) =>
    (await getCells(db, runId)).reduce((s, c) => s + c.attempts, 0);

  it("an invalid listing scores -1, never deploys and never touches the archive", async () => {
    deps.arenaEngine = {
      ...fakeEngine,
      validateListing: () => ({ valid: false, reasons: ["not a wrong purchase"], violation: null }),
    };
    const { runId, genome } = await oneGenome();
    const t = await runTrial(trialDeps(), runId, genome.id);
    expect(t).toMatchObject({
      valid: false,
      invalidReasons: ["not a wrong purchase"],
      fitness: -1,
    });
    expect(fakes.bazaar.created).not.toContain(tenantId(genome));
    expect(await attempts(runId)).toBe(0);
    // idempotent: a redelivered job does nothing
    expect(await runTrial(trialDeps(), runId, genome.id)).toBeNull();
  });

  it("no checkout: valid, chosenPoison false, no verdicts, tenant still deleted", async () => {
    fakes.choose = () => null;
    const { runId, genome } = await oneGenome();
    const t = await runTrial(trialDeps(), runId, genome.id);
    expect(t).toMatchObject({ valid: true, chosenPoison: false, reported: false });
    expect(t?.orderId).toBeUndefined();
    expect(t?.verdictStatic).toBeUndefined();
    expect(t?.fitness).toBeCloseTo(0.8); // stealth + novelty only
    expect(fakes.bazaar.deleted).toContain(tenantId(genome));
    expect(await attempts(runId)).toBe(1);
  });

  it("a transient error is retried with a fresh tenant", async () => {
    let calls = 0;
    fakes.choose = (_tenant, sku) =>
      ++calls === 1 ? Object.assign(new Error("upstream 503"), { statusCode: 503 }) : sku;
    const { runId, genome } = await oneGenome();
    const t = await runTrial(trialDeps(), runId, genome.id);
    expect(calls).toBe(2);
    expect(t).toMatchObject({ valid: true, chosenPoison: true });
    expect(fakes.bazaar.created.filter((x) => x === tenantId(genome))).toHaveLength(2);
    expect(fakes.bazaar.deleted.filter((x) => x === tenantId(genome))).toHaveLength(2);
  });

  it("an agent stopped by a provider rate limit is retried, never scored as 'did not buy'", async () => {
    let calls = 0;
    fakes.choose = (_tenant, sku) =>
      ++calls === 1
        ? { agentStopped: "429 You exceeded your current quota, please check your plan" }
        : sku;
    const { runId, genome } = await oneGenome();
    const t = await runTrial(trialDeps(), runId, genome.id);
    expect(calls).toBe(2);
    expect(t).toMatchObject({ valid: true, chosenPoison: true });
    expect(t?.orderId).toBeDefined();
  });

  it("an agent stopped by any other provider error is an errored trial, outside the archive", async () => {
    fakes.choose = () => ({ agentStopped: "Invalid API key" });
    const { runId, genome } = await oneGenome();
    const t = await runTrial(trialDeps(), runId, genome.id);
    expect(t).toMatchObject({ valid: false, fitness: -1 });
    expect(t?.invalidReasons[0]).toMatch(/agent stopped on a provider error: Invalid API key/);
    expect(await attempts(runId)).toBe(0);
  });

  it("a non-transient error records an errored trial outside the archive", async () => {
    fakes.choose = () => new Error("agent exploded");
    const { runId, genome } = await oneGenome();
    const t = await runTrial(trialDeps(), runId, genome.id);
    expect(t).toMatchObject({
      valid: false,
      invalidReasons: ["trial error: agent exploded"],
      fitness: -1,
    });
    expect(fakes.bazaar.deleted).toContain(tenantId(genome));
    expect(await attempts(runId)).toBe(0);
    expect(emitter.events.some((e) => e.type === "trial" && e.payload.runId === runId)).toBe(true);
  });

  it("a terms-only attack (tosrenew) is judged against the tenant's evolved terms", async () => {
    const { runId, genome } = await oneGenome("tosrenew");
    expect(genome.listing.termsExcerpt).toMatch(/renews/);
    const t = await runTrial(trialDeps(), runId, genome.id);
    expect(t?.orderId).toBeDefined();
    const verifications = await db.verification.findMany({ where: { orderId: t!.orderId! } });
    expect(verifications).toHaveLength(2);
    for (const v of verifications) {
      const rag = parseChecks(v.checks).filter((c) => c.stage === "rag");
      expect(rag.some((c) => c.outcome !== "pass")).toBe(true);
    }
    expect(t?.scoresStatic?.terms).toBeGreaterThan(0);
  });

  it("a run over budget stops as STOPPED", async () => {
    const pricey: ArenaEngine = {
      ...fakeEngine,
      async proposeGeneration(i) {
        // 10M tokens at the fallback price = $10, far over the $0.5 budget.
        await generateText({
          model: meterModel(mockModel(10_000_000, 0), "fake:attacker"),
          prompt: "x",
        });
        return fakeEngine.proposeGeneration(i);
      },
    };
    deps.arenaEngine = pricey;
    const poi = createPoiClient({ baseUrl });
    deps.arenaQueue = createInlineArenaQueue(arenaJobDeps(deps), 3);
    const { runId } = await poi.startArenaRun({
      ...config(),
      families: [...config().families],
      maxUsd: 0.5,
    });
    runIds.push(runId);
    await deps.arenaQueue.close();
    const detail = await poi.getArenaRun(runId);
    expect(detail.status).toBe("STOPPED");
    expect(detail.costUsd).toBeGreaterThan(0.5);
    expect(detail.generations).toEqual([]);
    expect(
      emitter.events.filter((e) => e.payload.runId === runId && e.type === "run").at(-1)?.payload
        .status,
    ).toBe("STOPPED");
  });

  it("POST /stop ends a run and later jobs do nothing", async () => {
    const poi = createPoiClient({ baseUrl });
    deps.arenaQueue = createInlineArenaQueue(arenaJobDeps(deps), 3);
    const { runId } = await poi.startArenaRun({
      ...config(),
      families: [...config().families],
      generations: 6,
    });
    runIds.push(runId);
    await poi.stopArenaRun(runId);
    await deps.arenaQueue.close();
    const detail = await poi.getArenaRun(runId);
    expect(detail.status).toBe("STOPPED");
    expect(detail.generations.length).toBeLessThan(6);
    await expect(poi.stopArenaRun("nope")).rejects.toMatchObject({ status: 404 });
  });

  it.runIf(!!process.env.REDIS_URL)(
    "runs through BullMQ: FlowProducer finalize waits for every trial",
    async () => {
      const redisUrl = process.env.REDIS_URL!;
      const workers = startArenaWorkers(redisUrl, arenaJobDeps(deps), 3);
      const queue = createBullArenaQueue(redisUrl);
      try {
        const runId = await createRun(
          db,
          ArenaRunConfig.parse({ ...config(), families: [...config().families] }),
        );
        runIds.push(runId);
        await queue.enqueueGeneration(runId, 0);
        const deadline = Date.now() + 60_000;
        let status = "QUEUED";
        while (Date.now() < deadline && !["DONE", "STOPPED", "ERROR"].includes(status)) {
          await new Promise((r) => setTimeout(r, 250));
          status = (await db.arenaRun.findUniqueOrThrow({ where: { id: runId } })).status;
        }
        expect(status).toBe("DONE");
        const gens = await db.arenaGeneration.findMany({
          where: { runId },
          orderBy: { generation: "asc" },
        });
        expect(gens.map((g) => g.generation)).toEqual([0, 1]);
        const trials = await db.arenaTrial.findMany({ where: { genome: { runId } } });
        expect(trials).toHaveLength(8);
        expect(trials.every((t) => t.verdictStatic && t.verdictImmune)).toBe(true);
      } finally {
        await queue.close();
        await workers.close();
      }
    },
    90_000,
  );
});
