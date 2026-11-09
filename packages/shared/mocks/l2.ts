/**
 * Layer 2 mock endpoints + timed socket events (docs/CONTRACTS-L2.md 4.4 / 4.7), so the
 * /arena, /immune and /calibration pages can be built before the real queues exist.
 * POST /api/arena/runs plays a fake evolution: arena:trial events, then arena:generation,
 * then immune:minted / immune:promoted when a trial is "reported".
 */
import type { Router } from "express";
import type { Namespace } from "socket.io";
import { fakeProposeGeneration, seededRandom } from "../src/arena-fake";
import {
  demoAntibodies,
  demoAntibodyDetail,
  demoArenaRun,
  demoCalibration,
  demoCalibrationCurve,
  demoDefender,
  demoGenomeRows,
  demoMerchantRisks,
  demoTrials,
  demoVerifyL2,
} from "../src/fixtures-l2";
import {
  AntibodyStatus,
  ArenaRunConfig,
  arenaRoom,
  AttackFamily,
  CalibrationRunRequest,
  Channel,
  GenomesQuery,
  IMMUNE_ROOM,
  ImmuneReportRequest,
  L2_EVENTS,
  type AntibodyDetail,
  type AntibodySummary,
  type ArchiveCell,
  type ArenaRunDetail,
  type ArenaRunSummary,
  type CalibrationResult,
  type DefenderInfo,
  type GenomeRow,
  type LiveClientToServerEvents,
  type LiveServerToClientEvents,
  type TrialResult,
  type VerifyRecordL2Fields,
} from "../src/l2";
import type { Verdict } from "../src/schemas";
import { HttpError, parse } from "./http";

type Live = Namespace<LiveClientToServerEvents, LiveServerToClientEvents>;

interface StoredRun {
  detail: ArenaRunDetail;
  genomes: GenomeRow[];
  timers: NodeJS.Timeout[];
}

const emptyCells = (): ArchiveCell[] =>
  AttackFamily.options.flatMap((family) =>
    Channel.options.map((channel) => ({
      family,
      channel,
      eliteGenomeId: null,
      eliteFitness: null,
      attempts: 0,
      wins: 0,
    })),
  );

export function mountL2Mock(
  r: Router,
  live: Live,
  opts: { intervalMs: number; nextId: (p: string) => string },
) {
  const { intervalMs, nextId } = opts;
  const runs = new Map<string, StoredRun>();
  runs.set(demoArenaRun.id, {
    detail: structuredClone(demoArenaRun),
    genomes: structuredClone(demoGenomeRows),
    timers: [],
  });
  const antibodies: AntibodySummary[] = structuredClone(demoAntibodies);
  let calibration: CalibrationResult = structuredClone(demoCalibration);
  const defender: DefenderInfo = structuredClone(demoDefender);
  const syncDefender = () => {
    defender.activeAntibodies = antibodies.filter((a) => a.status === "active").length;
  };

  live.on("connection", (socket) => {
    socket.on(L2_EVENTS.arenaSubscribe, (p) => {
      if (p && typeof p.runId === "string") void socket.join(arenaRoom(p.runId));
    });
    socket.on(L2_EVENTS.immuneSubscribe, () => void socket.join(IMMUNE_ROOM));
  });

  const getRun = (id: string) => {
    const run = runs.get(id);
    if (!run) throw new HttpError(404, "RUN_NOT_FOUND", `Arena run ${id} not found`);
    return run;
  };

  /** Mint a candidate antibody, then promote it a moment later (immune:minted -> immune:promoted). */
  function mintAndPromote(
    family: AntibodySummary["family"],
    sourceOrderId: string,
    after: number,
    timers: NodeJS.Timeout[],
  ) {
    const id = nextId("ab");
    timers.push(
      setTimeout(() => {
        antibodies.push({
          id,
          family,
          sourceOrderId,
          features: {
            recurrence_in_checkout: family === "subscription",
            hidden_text_present: family === "injection",
          },
          skeleton: family === "lookalike" ? "voltraofficial" : null,
          action: family === "injection" ? "ASK_HUMAN" : "VOID",
          status: "candidate",
          hits: 0,
          falseHits: 0,
          defenderVersion: defender.version,
          signature: "mock.jws.signature",
          createdAt: new Date().toISOString(),
        });
        live
          .to(IMMUNE_ROOM)
          .emit(L2_EVENTS.immuneMinted, { antibodyId: id, family, sourceOrderId });
      }, after),
      setTimeout(() => {
        const ab = antibodies.find((a) => a.id === id);
        if (!ab) return;
        ab.status = "active";
        defender.version += 1;
        ab.defenderVersion = defender.version;
        syncDefender();
        live.to(IMMUNE_ROOM).emit(L2_EVENTS.immunePromoted, {
          antibodyId: id,
          falseHits: 0,
          defenderVersion: defender.version,
        });
      }, after + intervalMs),
    );
  }

  /** Plays a fake evolution with timed events. */
  async function play(run: StoredRun) {
    const { detail } = run;
    const cfg = detail.config;
    const rand = seededRandom(detail.id.length * 97 + cfg.populationSize);
    const room = live.to(arenaRoom(detail.id));
    // Give clients time to subscribe to arena:{runId} after POST returns the id.
    let t = Math.max(intervalMs, 250);
    const at = (fn: () => void) => run.timers.push(setTimeout(fn, (t += intervalMs)));
    at(() => {
      detail.status = "RUNNING";
      room.emit(L2_EVENTS.arenaRun, {
        runId: detail.id,
        status: "RUNNING",
        costUsd: detail.costUsd,
      });
    });
    for (let generation = 0; generation < cfg.generations; generation++) {
      const drafts = await fakeProposeGeneration({
        runId: detail.id,
        generation,
        populationSize: cfg.populationSize,
        archive: detail.cells,
        elites: [],
        library: [],
        families: cfg.families,
        scenarios: [],
        attackerModel: cfg.attackerModel,
        seed: 7 + generation,
      });
      const trials: TrialResult[] = [];
      drafts.forEach((d, i) => {
        const genomeId = nextId("gen");
        const chosenPoison = rand() < 0.75;
        const fooledStatic = chosenPoison && rand() < 0.2 + generation * 0.12;
        const verdictStatic: Verdict =
          !chosenPoison || fooledStatic ? "CAPTURE" : rand() < 0.7 ? "VOID" : "ASK_HUMAN";
        const verdictImmune: Verdict = fooledStatic && generation > 0 ? "VOID" : verdictStatic;
        const fitness =
          Math.round(((chosenPoison ? 1 : 0) + (fooledStatic ? 2 : 0) + rand() * 0.8) * 100) / 100;
        const trial: TrialResult = {
          trialId: nextId("trial"),
          runId: detail.id,
          genomeId,
          generation,
          agentModel: cfg.agentModel,
          valid: true,
          invalidReasons: [],
          orderId: `MOCKARENA${generation}${i}`,
          chosenPoison,
          verdictStatic,
          verdictImmune,
          stealthP: Math.round(rand() * 100) / 100,
          noveltyCos: Math.round((0.3 + rand() * 0.6) * 100) / 100,
          fitness,
          reported: fooledStatic && cfg.immuneLearning,
          costUsd: 0.14,
          latencyMs: 9000 + Math.round(rand() * 5000),
        };
        trials.push(trial);
        at(() => {
          if (detail.status !== "RUNNING") return;
          const cell = detail.cells.find((c) => c.family === d.family && c.channel === d.channel)!;
          cell.attempts += 1;
          if (chosenPoison && verdictStatic === "CAPTURE") cell.wins += 1;
          const replacedElite = cell.eliteFitness === null || fitness > cell.eliteFitness;
          if (replacedElite) {
            cell.eliteGenomeId = genomeId;
            cell.eliteFitness = fitness;
          }
          run.genomes.push({
            ...d,
            id: genomeId,
            runId: detail.id,
            generation,
            split: cfg.split,
            attackerModel: cfg.attackerModel,
            bestTrial: trial,
          });
          detail.costUsd = Math.round((detail.costUsd + trial.costUsd) * 100) / 100;
          room.emit(L2_EVENTS.arenaTrial, {
            runId: detail.id,
            generation,
            genomeId,
            family: d.family,
            channel: d.channel,
            fitness,
            chosenPoison,
            verdictStatic,
            verdictImmune,
            replacedElite,
          });
          if (trial.reported) mintAndPromote(d.family, trial.orderId!, intervalMs, run.timers);
        });
      });
      at(() => {
        if (detail.status !== "RUNNING") return;
        const asr = (arm: "verdictStatic" | "verdictImmune") =>
          Math.round(
            (trials.filter((x) => x.chosenPoison && x[arm] === "CAPTURE").length / trials.length) *
              1000,
          ) / 1000;
        const stats = {
          generation,
          asrStatic: asr("verdictStatic"),
          asrImmune: asr("verdictImmune"),
          coverage: detail.cells.filter((c) => c.eliteGenomeId).length,
          bestFitness: Math.max(...detail.cells.map((c) => c.eliteFitness ?? 0)),
          defenderVersion: defender.version,
        };
        detail.generations.push(stats);
        room.emit(L2_EVENTS.arenaGeneration, { runId: detail.id, ...stats });
      });
    }
    at(() => {
      if (detail.status !== "RUNNING") return;
      detail.status = "DONE";
      room.emit(L2_EVENTS.arenaRun, { runId: detail.id, status: "DONE", costUsd: detail.costUsd });
    });
  }

  const summary = (run: StoredRun): ArenaRunSummary => ({
    id: run.detail.id,
    status: run.detail.status,
    costUsd: run.detail.costUsd,
    createdAt: run.detail.createdAt,
    config: run.detail.config,
    generationsDone: run.detail.generations.length,
  });

  // --- arena ---------------------------------------------------------------------------
  r.post("/arena/runs", (req, res) => {
    const config = parse(ArenaRunConfig, req.body);
    const id = nextId("arena");
    const run: StoredRun = {
      detail: {
        id,
        config,
        status: "QUEUED",
        costUsd: 0,
        createdAt: new Date().toISOString(),
        generations: [],
        cells: emptyCells(),
      },
      genomes: [],
      timers: [],
    };
    runs.set(id, run);
    void play(run);
    res.status(201).json({ runId: id });
  });

  r.get("/arena/runs", (_req, res) => {
    res.json(
      [...runs.values()].map(summary).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  });

  r.get("/arena/runs/:id", (req, res) => {
    res.json(getRun(req.params.id).detail);
  });

  r.get("/arena/runs/:id/genomes", (req, res) => {
    const q = parse(GenomesQuery, req.query);
    res.json(
      getRun(req.params.id).genomes.filter(
        (g) =>
          (q.gen === undefined || g.generation === q.gen) && (!q.family || g.family === q.family),
      ),
    );
  });

  r.get("/arena/genomes/:id", (req, res) => {
    const all = [...runs.values()].flatMap((x) => x.genomes);
    const row = all.find((g) => g.id === req.params.id);
    if (!row) throw new HttpError(404, "GENOME_NOT_FOUND", `Genome ${req.params.id} not found`);
    const { bestTrial, ...genome } = row;
    const parents = all
      .filter((g) => row.parentIds.includes(g.id))
      .map(({ bestTrial: _b, ...g }) => g);
    const trials = bestTrial ? [bestTrial] : demoTrials.filter((x) => x.genomeId === row.id);
    res.json({ genome, parents, trials });
  });

  r.post("/arena/runs/:id/stop", (req, res) => {
    const run = getRun(req.params.id);
    run.timers.forEach((x) => clearTimeout(x));
    if (run.detail.status === "RUNNING" || run.detail.status === "QUEUED") {
      run.detail.status = "STOPPED";
      live.to(arenaRoom(run.detail.id)).emit(L2_EVENTS.arenaRun, {
        runId: run.detail.id,
        status: "STOPPED",
        costUsd: run.detail.costUsd,
      });
    }
    res.json({ ok: true });
  });

  // --- immune ---------------------------------------------------------------------------
  r.get("/immune/antibodies", (req, res) => {
    const state = req.query.state ? parse(AntibodyStatus, req.query.state) : undefined;
    res.json(antibodies.filter((a) => !state || a.status === state));
  });

  r.get("/immune/antibodies/:id", (req, res) => {
    const ab = antibodies.find((a) => a.id === req.params.id);
    if (!ab) throw new HttpError(404, "ANTIBODY_NOT_FOUND", `Antibody ${req.params.id} not found`);
    const fixture = demoAntibodyDetail(ab.id);
    const detail: AntibodyDetail = fixture
      ? { ...fixture, antibody: ab }
      : { antibody: ab, recentHits: [], sourceOrder: null };
    res.json(detail);
  });

  r.post("/immune/antibodies/:id/retire", (req, res) => {
    const ab = antibodies.find((a) => a.id === req.params.id);
    if (!ab) throw new HttpError(404, "ANTIBODY_NOT_FOUND", `Antibody ${req.params.id} not found`);
    ab.status = "retired";
    syncDefender();
    res.json(ab);
  });

  r.post("/immune/report", (req, res) => {
    const body = parse(ImmuneReportRequest, req.body);
    // The demo order's subscription is already covered: the report merges into ab_sub_1.
    if (
      body.orderId === demoAntibodyDetail("ab_sub_1")?.sourceOrder?.orderId ||
      /care\+|subscription/i.test(body.reason)
    ) {
      res.json({ antibodyId: "ab_sub_1" });
      return;
    }
    mintAndPromote("subscription", body.orderId, intervalMs, []);
    res.json({});
  });

  r.get("/immune/merchants", (_req, res) => {
    res.json(demoMerchantRisks);
  });

  // --- calibration + defender -----------------------------------------------------------
  r.post("/calibration/run", (req, res) => {
    const { alpha } = parse(CalibrationRunRequest, req.body);
    const point = [...demoCalibrationCurve].sort(
      (a, b) => Math.abs(a.alpha - alpha) - Math.abs(b.alpha - alpha),
    )[0]!;
    calibration = {
      ...demoCalibration,
      id: nextId("cal"),
      alpha,
      lambdaAsk: point.lambdaAsk,
      lambdaVoid: Math.max(point.lambdaAsk, demoCalibration.lambdaVoid),
      empiricalMiss: point.empiricalMiss,
      benignAskRate: point.benignAskRate,
      createdAt: new Date().toISOString(),
    };
    defender.activeCalibrationId = calibration.id;
    live.to(IMMUNE_ROOM).emit(L2_EVENTS.calibrationUpdated, {
      calibrationId: calibration.id,
      alpha,
      lambdaAsk: calibration.lambdaAsk,
      lambdaVoid: calibration.lambdaVoid,
    });
    res.json(calibration);
  });

  r.get("/calibration/latest", (_req, res) => {
    res.json(calibration);
  });

  r.get("/calibration/curve", (_req, res) => {
    res.json(demoCalibrationCurve);
  });

  r.get("/defender", (_req, res) => {
    res.json(defender);
  });

  /** Layer 2 additions for GET /verify/:orderId. */
  return {
    verifyExtras(voided: boolean): VerifyRecordL2Fields {
      const cal = {
        alpha: calibration.alpha,
        lambdaAsk: calibration.lambdaAsk,
        lambdaVoid: calibration.lambdaVoid,
        n: calibration.n,
        calibrationId: calibration.id,
      };
      return voided
        ? { ...demoVerifyL2, calibration: cal, defenderVersion: defender.version }
        : {
            immuneMatches: [],
            antibodies: [],
            merchantRisk: demoVerifyL2.merchantRisk ?? null,
            calibration: cal,
            defenderVersion: defender.version,
            counterfactual: null,
          };
    },
  };
}
