// Layer 2 persistence (task Q1). LSH is pure; the repo tests need Postgres (RUN_DB_TESTS=1).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArenaRunConfig, type TrialResult } from "@poi/shared";
import { demoAntibodyMinhashes, demoGenomes } from "@poi/shared/fixtures-l2";
import {
  addRunCost,
  createRun,
  getCells,
  getEliteEmbeddings,
  getElites,
  getRunDetail,
  getTrialsForGeneration,
  insertGenome,
  insertTrial,
  listGenomeRows,
  listRuns,
  listStrategies,
  recordCellTrial,
  recordGeneration,
  upsertStrategies,
} from "../src/arena/archive.repo";
import {
  activeCalibration,
  getCalibration,
  insertCalibration,
  latestCalibration,
} from "../src/calibration/calibration.repo";
import {
  activateAntibody,
  candidatesByBands,
  getAntibody,
  insertCandidate,
  listAntibodies,
  nearestByEmbedding,
  recordFalseHit,
  recordHit,
  rejectCandidate,
  retireAntibody,
} from "../src/immune/antibody.repo";
import {
  bumpVersion,
  getDefender,
  setActiveCalibration,
  snapshotDefender,
} from "../src/immune/defender";
import { estimatedJaccard, lshBands } from "../src/immune/lsh";
import { disconnectPrisma, getPrisma } from "../src/lib/prisma";

const unit = (i: number) => Array.from({ length: 1536 }, (_, k) => (k === i ? 1 : 0));
const minhashA = demoAntibodyMinhashes["ab_sub_1"]!;
const minhashB = demoAntibodyMinhashes["ab_look_1"]!;

describe("LSH banding", () => {
  it("makes 32 stable band hashes; one changed number changes exactly one band", () => {
    const a = lshBands(minhashA);
    expect(a).toHaveLength(32);
    expect(lshBands([...minhashA])).toEqual(a);
    const tweaked = [...minhashA];
    tweaked[9] = tweaked[9]! + 1; // row 9 lives in band 2
    const b = lshBands(tweaked);
    expect(a.filter((h, i) => h !== b[i])).toHaveLength(1);
    expect(a[2]).not.toBe(b[2]);
    expect(() => lshBands([1, 2, 3])).toThrow(/128/);
  });

  it("estimates Jaccard as the agreeing fraction", () => {
    expect(estimatedJaccard(minhashA, minhashA)).toBe(1);
    const half = minhashA.map((x, i) => (i < 64 ? x : x + 1));
    expect(estimatedJaccard(minhashA, half)).toBe(0.5);
  });
});

describe.runIf(process.env.RUN_DB_TESTS === "1")("Layer 2 repos (real DB)", () => {
  const db = getPrisma();
  const createdAntibodies: string[] = [];
  let runId = "";
  let calibrationBefore: string | null | undefined;
  beforeAll(async () => {
    calibrationBefore = (await db.defenderState.findUnique({ where: { id: 1 } }))
      ?.activeCalibrationId;
  });
  afterAll(async () => {
    // Leave no live antibodies, arena rows or test calibration active in a dev database.
    await db.defenderState.update({
      where: { id: 1 },
      data: { activeCalibrationId: calibrationBefore ?? null },
    });
    if (createdAntibodies.length)
      await db.antibody.deleteMany({ where: { id: { in: createdAntibodies } } });
    if (runId) {
      await db.arenaTrial.deleteMany({ where: { genome: { runId } } });
      await db.attackGenome.deleteMany({ where: { runId } });
      await db.arenaCell.deleteMany({ where: { runId } });
      await db.arenaGeneration.deleteMany({ where: { runId } });
      await db.arenaRun.delete({ where: { id: runId } });
    }
    await db.strategyEntry.deleteMany({ where: { id: { startsWith: "test-strat-" } } });
    await disconnectPrisma();
  });

  it("arena: run with 42 cells, atomic elite replacement, cost, generations", async () => {
    const config = ArenaRunConfig.parse({
      attackerModel: "fake:a",
      agentModel: "fake:b",
      families: ["subscription"],
    });
    runId = await createRun(db, config);
    expect(await getCells(db, runId)).toHaveLength(42);
    expect((await listRuns(db)).find((r) => r.id === runId)).toMatchObject({
      status: "QUEUED",
      generationsDone: 0,
    });

    const key = { runId, family: "subscription", channel: "checkout" };
    // Two trials land at once: the higher fitness must win regardless of order.
    const [r1, r2] = await Promise.all([
      recordCellTrial(db, key, { genomeId: "g-low", fitness: 2, won: true }),
      recordCellTrial(db, key, { genomeId: "g-high", fitness: 3, won: false }),
    ]);
    expect(r1 || r2).toBe(true);
    expect(await recordCellTrial(db, key, { genomeId: "g-worse", fitness: 1, won: false })).toBe(
      false,
    );
    const cell = (await getCells(db, runId)).find(
      (c) => c.family === "subscription" && c.channel === "checkout",
    )!;
    expect(cell).toMatchObject({ eliteGenomeId: "g-high", eliteFitness: 3, attempts: 3, wins: 1 });

    expect(await addRunCost(db, runId, 0.25)).toBeCloseTo(0.25);
    expect(await addRunCost(db, runId, 0.5)).toBeCloseTo(0.75);
    const stats = {
      generation: 0,
      asrStatic: 0.3,
      asrImmune: 0.1,
      coverage: 1,
      bestFitness: 3,
      defenderVersion: 0,
    };
    await recordGeneration(db, runId, stats);
    await recordGeneration(db, runId, { ...stats, asrImmune: 0.05 }); // retried job overwrites
    const detail = await getRunDetail(db, runId);
    expect(detail?.generations).toEqual([{ ...stats, asrImmune: 0.05 }]);
    expect(detail?.costUsd).toBeCloseTo(0.75);
  });

  it("arena: genomes with embeddings, elites, best trial per genome", async () => {
    const draft = demoGenomes[0]!;
    const g = await insertGenome(
      db,
      { ...draft, runId, generation: 0, split: "train", attackerModel: "fake:a" },
      unit(3),
    );
    expect(g.listing.sku).toBe(draft.listing.sku);
    const key = { runId, family: g.family, channel: g.channel };
    await recordCellTrial(db, key, { genomeId: g.id, fitness: 9, won: true });
    expect((await getElites(db, runId)).map((e) => e.id)).toContain(g.id);
    const embeddings = await getEliteEmbeddings(db, runId);
    expect(embeddings).toHaveLength(1);
    expect(embeddings[0]![3]).toBe(1);

    const trial = (fitness: number, id: string): TrialResult => ({
      trialId: id,
      runId,
      genomeId: g.id,
      generation: 0,
      agentModel: "fake:b",
      valid: true,
      invalidReasons: [],
      chosenPoison: true,
      verdictStatic: "CAPTURE",
      verdictImmune: "VOID",
      stealthP: 0.2,
      noveltyCos: 0.4,
      fitness,
      reported: true,
      costUsd: 0.1,
      latencyMs: 1000,
    });
    await insertTrial(db, trial(1.5, `test-trial-${runId}-a`));
    await insertTrial(db, trial(2.5, `test-trial-${runId}-b`));
    const rows = await listGenomeRows(db, runId, { gen: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bestTrial?.fitness).toBe(2.5);
    expect(await getTrialsForGeneration(db, runId, 0)).toHaveLength(2);
  });

  it("strategy library upserts", async () => {
    await upsertStrategies(db, [
      {
        id: "test-strat-1",
        family: "subscription",
        channel: "checkout",
        text: "x",
        wins: 1,
        losses: 0,
      },
    ]);
    await upsertStrategies(db, [
      { id: "test-strat-1", family: "subscription", text: "x, refined", wins: 2, losses: 1 },
    ]);
    expect(
      (await listStrategies(db, "subscription")).find((s) => s.id === "test-strat-1"),
    ).toMatchObject({ text: "x, refined", wins: 2, losses: 1 });
  });

  it("antibodies: LSH candidates only when live, embeddings, hits", async () => {
    const before = (await getDefender(db)).version;
    const a = await insertCandidate(
      db,
      {
        family: "subscription",
        sourceOrderId: "TEST-ORDER-A",
        minhash: minhashA,
        features: { recurrence_in_checkout: true },
        skeleton: null,
        action: "VOID",
        defenderVersion: before,
        signature: "test.jws",
      },
      unit(7),
    );
    createdAntibodies.push(a.id);
    expect(a.status).toBe("candidate");
    expect(await db.antibodyBand.count({ where: { antibodyId: a.id } })).toBe(32);

    // A candidate is invisible to live matching, but visible to an explicit (snapshot) scope.
    expect((await candidatesByBands(db, minhashA)).map((x) => x.id)).not.toContain(a.id);
    expect((await candidatesByBands(db, minhashA, { ids: [a.id] })).map((x) => x.id)).toEqual([
      a.id,
    ]);

    const v = await bumpVersion(db, "test: promote A", (tx, version) =>
      activateAntibody(tx, a.id, version),
    );
    expect(v).toBe(before + 1);
    expect((await candidatesByBands(db, minhashA)).map((x) => x.id)).toContain(a.id);
    expect((await candidatesByBands(db, minhashB)).map((x) => x.id)).not.toContain(a.id);
    const near = await nearestByEmbedding(db, unit(7), { ids: [a.id] });
    expect(near[0]).toMatchObject({ id: a.id });
    expect(near[0]!.cosine).toBeCloseTo(1);

    await recordHit(db, a.id);
    expect(await recordFalseHit(db, a.id)).toEqual({ hits: 1, falseHits: 1 });
    expect((await getAntibody(db, a.id))?.status).toBe("active");
    expect((await listAntibodies(db, "active")).find((x) => x.id === a.id)).not.toHaveProperty(
      "minhash",
    );
  });

  it("defender: snapshots are exact across promote, reject, retire and calibration", async () => {
    const mk = async (sourceOrderId: string) => {
      const v0 = (await getDefender(db)).version;
      const ab = await insertCandidate(db, {
        family: "lookalike",
        sourceOrderId,
        minhash: minhashB,
        features: {},
        skeleton: "voltraofficial",
        action: "VOID",
        defenderVersion: v0,
        signature: "test.jws",
      });
      createdAntibodies.push(ab.id);
      return ab.id;
    };
    const A = await mk("TEST-SNAP-A");
    const vA = await bumpVersion(db, "test: promote snapshot A", (tx, v) =>
      activateAntibody(tx, A, v),
    );
    const R = await mk("TEST-SNAP-REJECTED");
    await rejectCandidate(db, R);
    const B = await mk("TEST-SNAP-B");
    const vB = await bumpVersion(db, "test: promote snapshot B", (tx, v) =>
      activateAntibody(tx, B, v),
    );

    const cal = await insertCalibration(
      db,
      {
        alpha: 0.05,
        n: 200,
        nViolating: 80,
        lambdaAsk: 0.42,
        lambdaVoid: 0.88,
        empiricalMiss: 0.045,
        benignAskRate: 0.05,
        benignVoidRate: 0.01,
        perFamily: [],
      },
      vB,
    );
    expect(await getCalibration(db, cal.id)).toEqual(cal);
    expect((await latestCalibration(db))?.id).toBe(cal.id);
    await setActiveCalibration(db, cal.id);
    expect((await activeCalibration(db))?.id).toBe(cal.id);

    const vRetire = await bumpVersion(db, "test: retire snapshot A", (tx, v) =>
      retireAntibody(tx, A, v),
    );
    const mine = (ids: string[]) => ids.filter((id) => [A, B, R].includes(id)).sort();

    const sA = await snapshotDefender(db, vA);
    const sB = await snapshotDefender(db, vB);
    const sR = await snapshotDefender(db, vRetire);
    expect(mine(sA.antibodyIds)).toEqual([A].sort());
    expect(mine(sB.antibodyIds)).toEqual([A, B].sort());
    expect(mine(sR.antibodyIds)).toEqual([B]);
    expect(sB.calibrationId).toBe(cal.id); // set while vB was current
    expect(sR.calibrationId).toBe(cal.id); // carried into the next version
    expect((await getDefender(db)).version).toBe(vRetire);
    await expect(snapshotDefender(db, vRetire + 1000)).rejects.toThrow(/does not exist/);
    await expect(retireAntibody(db, A, vRetire)).rejects.toThrow(/not active/);
  });
});
