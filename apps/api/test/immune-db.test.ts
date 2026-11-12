// Layer 2 end to end (Q4-Q9) against real Postgres, with the arena's fake edges (Bazaar tenants,
// shopper, PayPal). Each run uses its own verified seller, so counters left behind by earlier
// runs in a dev database can't change the outcome.
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArenaRunConfig,
  BazaarProduct,
  createPoiClient,
  type AttackFamily,
  type Genome,
} from "@poi/shared";
import { defaultChannel, mutateListing, seededRandom } from "@poi/shared/arena-fake";
import { seedPoisonListings } from "@poi/shared/fixtures-l2";
import { arenaJobDeps, buildDeps, createApp, immuneWorkerDeps, type AppDeps } from "../src/app";
import { createRun, insertGenome, setRunStatus } from "../src/arena/archive.repo";
import { fakeEngine } from "../src/arena/engine";
import { ensureArenaIntent } from "../src/arena/intents";
import { runTrial } from "../src/arena/trial.job";
import { sha256Canonical } from "../src/evidence/canonical";
import { loadSigningKey, type SigningKey } from "../src/evidence/keys";
import { getAntibody, markFalseHits, recordHits } from "../src/immune/antibody.repo";
import { loadBenignItems } from "../src/immune/benign";
import { getDefender, snapshotDefender } from "../src/immune/defender";
import { mintAntibody } from "../src/immune/mint.job";
import { promoteAntibody } from "../src/immune/promote.job";
import { verifyAntibodySignature } from "../src/immune/sign";
import { listingText } from "@poi/arena";
import { disconnectPrisma, getPrisma } from "../src/lib/prisma";
import { parseChecks } from "../src/lib/mappers";
import { noopArenaEmitter } from "../src/realtime/arena-emitter";
import { runVerification } from "../src/verifier/pipeline";
import { arenaFakes, bazaarData, scenarios } from "./arena-fakes";
import { testSigningKey } from "./helpers";

const RUN = Date.now().toString(36);
const SELLER = { id: `sentra-${RUN}`, displayName: `Sentra ${RUN}`, verified: true };

describe.runIf(process.env.RUN_DB_TESTS === "1")(
  "immune memory, risk, calibration (real DB)",
  () => {
    const db = getPrisma();
    const fakes = arenaFakes();
    const runIds: string[] = [];
    const orderIds: string[] = [];
    let key: SigningKey;
    let deps: AppDeps;
    let baseUrl = "";
    let server: ReturnType<typeof createServer>;

    const immune = () => ({ ...immuneWorkerDeps(deps), enqueuePromote: async () => {} });

    let calibrationBefore: string | null | undefined;
    beforeAll(async () => {
      calibrationBefore = (await db.defenderState.findUnique({ where: { id: 1 } }))
        ?.activeCalibrationId;
      key = process.env.POI_SIGNING_JWK
        ? await loadSigningKey(process.env.POI_SIGNING_JWK)
        : await testSigningKey();
      for (const m of bazaarData.merchants)
        await db.merchant.upsert({ where: { id: m.id }, create: m, update: m });
      await db.merchant.upsert({ where: { id: SELLER.id }, create: SELLER, update: SELLER });
      fakes.merchants.set(SELLER.id, SELLER);
      deps = buildDeps({
        paypal: fakes.paypal,
        signingKey: async () => key,
        compilerModel: undefined,
        judgeModel: undefined,
        injectionModel: undefined,
        embeddingModel: undefined,
        agentModel: () => undefined,
        listingCard: async () => undefined,
        arenaEngine: fakeEngine,
        arenaEmitter: noopArenaEmitter,
        arenaScenarios: async () => scenarios,
        arenaBazaar: fakes.bazaar,
        arenaShop: fakes.shop,
        // minting is driven explicitly below, so each step can be checked on its own
        enqueueMint: async () => {},
      });
      server = createServer(createApp(deps));
      await new Promise<void>((r) => server.listen(0, r));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      // the test's calibration must not stay active in a dev database
      await db.defenderState.update({
        where: { id: 1 },
        data: { activeCalibrationId: calibrationBefore ?? null },
      });
      await db.antibody.deleteMany({ where: { sourceOrderId: { in: orderIds } } });
      for (const runId of runIds) {
        await db.arenaTrial.deleteMany({ where: { genome: { runId } } });
        await db.attackGenome.deleteMany({ where: { runId } });
        await db.arenaCell.deleteMany({ where: { runId } });
        await db.arenaRun.deleteMany({ where: { id: runId } });
      }
      await db.merchantRisk.deleteMany({ where: { merchantId: { contains: SELLER.id } } });
      await disconnectPrisma();
    });

    /** A Layer 1 poisoned listing, by sku. */
    const seedListing = (sku: string) =>
      BazaarProduct.parse(seedPoisonListings.find((p) => p.sku === sku)!);

    /** A RUNNING run with one genome for this listing, sold by this run's seller. */
    async function genome(family: AttackFamily, listing: BazaarProduct, scenarioId?: string) {
      const runId = await createRun(
        db,
        ArenaRunConfig.parse({
          attackerModel: "fake:attacker",
          agentModel: "fake:agent",
          families: [family],
          generations: 1,
          populationSize: 4,
        }),
      );
      runIds.push(runId);
      await setRunStatus(db, runId, "RUNNING");
      const scenario =
        scenarios.find((s) => s.category === listing.category && s.family === family) ??
        scenarios.find((s) => s.category === listing.category)!;
      const sold = { ...listing, merchantId: SELLER.id };
      return insertGenome(db, {
        family,
        channel: defaultChannel(family, sold),
        operator: "seed",
        parentIds: [],
        strategy: "test",
        scenarioId: scenarioId ?? scenario.id,
        listing: sold,
        runId,
        generation: 0,
        split: "train",
        attackerModel: "fake:attacker",
      });
    }
    const trial = async (g: Genome) => {
      const t = await runTrial(
        { ...arenaJobDeps(deps), enqueueGeneration: async () => {}, retryDelayMs: 1 },
        g.runId,
        g.id,
      );
      if (t?.orderId) orderIds.push(t.orderId);
      return t!;
    };
    const immuneArm = async (orderId: string) => {
      const vs = await db.verification.findMany({ where: { orderId } });
      return vs.find((v) => (v.config as { immune?: boolean }).immune)!;
    };

    let specific: { genome: Genome; orderId: string; antibodyId: string };
    let lookalikeOrder = "";

    it("Q4: a reported hidden-subscription order becomes a signed CANDIDATE with 32 bands", async () => {
      const g = await genome("subscription", seedListing("HUB-SUB-01"));
      const t = await trial(g);
      expect(t.orderId).toBeDefined();
      const res = await mintAntibody(immune(), {
        orderId: t.orderId!,
        family: "subscription",
        source: "report",
      });
      expect(res?.outcome).toBe("created");
      const a = (await getAntibody(db, res!.antibodyId))!;
      expect(a).toMatchObject({ status: "candidate", family: "subscription", action: "VOID" });
      expect(a.features).toMatchObject({ recurrence_in_checkout: true, digital_extra_line: true });
      expect(await db.antibodyBand.count({ where: { antibodyId: a.id } })).toBe(32);
      expect(await verifyAntibodySignature(a, key.publicKey)).toBe(true);
      // minting is once per source order
      expect(
        (
          await mintAntibody(immune(), {
            orderId: t.orderId!,
            family: "subscription",
            source: "report",
          })
        )?.outcome,
      ).toBe("exists");
    });

    it("Q6: a specific antibody passes the gate and goes live (version + 1)", async () => {
      // "(30-day trial)" only in the line name: Layer 1's rules (no LLMs) miss it
      const g = await genome("subscription", seedListing("EAR-SUB-01"));
      const t = await trial(g);
      expect(t.verdictStatic).toBe("CAPTURE");
      const res = (await mintAntibody(immune(), {
        orderId: t.orderId!,
        family: "subscription",
        source: "arena-oracle",
      }))!;
      const before = (await getDefender(db)).version;
      const p = await promoteAntibody(immuneWorkerDeps(deps), res.antibodyId);
      expect(p).toMatchObject({ outcome: "promoted", selfMatch: true, benignHits: [] });
      expect(p.defenderVersion).toBeGreaterThan(before);
      expect((await getAntibody(db, res.antibodyId))?.status).toBe("active");
      specific = { genome: g, orderId: t.orderId!, antibodyId: res.antibodyId };
      // a near-identical report is absorbed instead of minting a duplicate
      const again = await genome("subscription", g.listing, g.scenarioId);
      const t2 = await trial(again);
      expect(
        await mintAntibody(immune(), {
          orderId: t2.orderId!,
          family: "subscription",
          source: "report",
        }),
      ).toEqual({
        antibodyId: res.antibodyId,
        outcome: "merged",
      });
    });

    it("Q6: generic text that honest listings share is rejected by the gate", async () => {
      const benign = loadBenignItems("bench/evolved/benign-40.json")[0]!;
      const scenario = scenarios[0]!;
      const { intentId } = await ensureArenaIntent(
        { prisma: () => db, signingKey: async () => key },
        `generic-${RUN}`,
        scenario,
      );
      const orderId = `GENERIC-${RUN}`;
      orderIds.push(orderId);
      const text = listingText(benign.product).split(" ").slice(0, 60).join(" ");
      await db.orderRecord.create({
        data: {
          id: orderId,
          intentId,
          merchantId: benign.merchantId,
          mode: "DRY_RUN",
          paypalStatus: "UNKNOWN",
          normalized: { ...benign.normalizedOrder, orderId },
          agentTrace: {
            model: "fake:agent",
            userText: scenario.userText,
            steps: [],
            observedListings: [{ sku: benign.sku, pageText: text }],
            chosenSkus: [benign.sku],
          },
        },
      });
      const res = (await mintAntibody(immune(), { orderId, family: "variant", source: "report" }))!;
      const p = await promoteAntibody(immuneWorkerDeps(deps), res.antibodyId);
      expect(p.outcome).toBe("rejected");
      expect(p.benignHits.map((h) => h.sku)).toContain(benign.sku);
      expect((await getAntibody(db, res.antibodyId))?.status).toBe("retired");
    });

    it("Q5: an evolved mutant (new wording and price) is raised by the immune stage", async () => {
      const mutant = BazaarProduct.parse(
        mutateListing(
          specific.genome.listing,
          "subscription",
          { generation: 1, index: 7 },
          seededRandom(99),
        ),
      );
      expect(mutant.priceUsd).not.toBe(specific.genome.listing.priceUsd);
      const g = await genome("subscription", mutant, specific.genome.scenarioId);
      const t = await trial(g);
      expect(t.verdictStatic).toBe("CAPTURE");
      expect(["ASK_HUMAN", "VOID"]).toContain(t.verdictImmune);
      const v = await immuneArm(t.orderId!);
      const immuneCheck = parseChecks(v.checks).find((c) => c.check === "immune");
      expect(immuneCheck).toMatchObject({ outcome: "fail" });
      const l2 = v.l2 as { immuneMatches: Array<{ antibodyId: string }>; layer1Verdict: string };
      expect(l2.immuneMatches.map((m) => m.antibodyId)).toContain(specific.antibodyId);
      expect(l2.layer1Verdict).toBe("CAPTURE");
      // dry-run matches are logged but don't count as live hits
      expect(await db.antibodyHit.count({ where: { verificationId: v.id } })).toBeGreaterThan(0);
      expect((await getAntibody(db, specific.antibodyId))?.hits).toBe(0);
    });

    it("the immune arm reuses the static arm's Layer 1: one PayPal read, same checks, never laxer", async () => {
      const g = await genome("subscription", seedListing("EAR-SUB-01"));
      const t = await trial(g);
      const vs = await db.verification.findMany({
        where: { orderId: t.orderId! },
        orderBy: { createdAt: "asc" },
      });
      const stat = vs.find((v) => !(v.config as { immune?: boolean }).immune)!;
      const imm = vs.find((v) => (v.config as { immune?: boolean }).immune)!;
      expect((imm.l2 as { layer1From?: string }).layer1From).toBe(stat.id);
      // PayPal was read once for the order, by the static arm only
      expect(fakes.orderReads.filter((id) => id === t.orderId)).toHaveLength(1);
      // the immune arm's Layer 1 checks are exactly the static arm's
      const layer1 = (checks: unknown) =>
        parseChecks(checks)
          .filter((c) => c.check !== "immune" && c.check !== "risk")
          .map((c) => `${c.check}:${c.outcome}:${c.severity}:${c.reason}`);
      expect(layer1(imm.checks)).toEqual(layer1(stat.checks));
      const RANK = { CAPTURE: 0, ASK_HUMAN: 1, VOID: 2 } as const;
      expect(RANK[imm.verdict!]).toBeGreaterThanOrEqual(RANK[stat.verdict!]);
      // and reusing another order's verification is refused
      const other = await db.verification.create({
        data: { orderId: specific.orderId, mode: "DRY_RUN", config: { immune: true } },
      });
      await expect(runVerification(deps, other.id, { layer1From: stat.id })).rejects.toThrow(
        /not a finished verification of order/,
      );
    });

    it("Q9: /verify carries the Layer 2 fields, and the signed evidence covers them", async () => {
      const orders = await db.orderRecord.findMany({
        where: { id: { in: orderIds }, merchantId: SELLER.id },
      });
      const raised = orders.at(-1)!; // the mutant
      const poi = createPoiClient({ baseUrl });
      const rec = await poi.getVerifyRecord(raised.id);
      // the latest verification of the order is the immune arm
      expect(rec.immuneMatches?.length).toBeGreaterThan(0);
      expect(rec.antibodies?.map((a) => a.id)).toContain(specific.antibodyId);
      expect(rec.merchantRisk?.merchantId).toBe(`arena:${SELLER.id}`);
      expect(typeof rec.defenderVersion).toBe("number");
      expect(rec.counterfactual).toMatchObject({ annualExtraUsd: expect.any(Number) });
      expect(rec.chainValid).toBe(true);
      const payload = rec.evidence!.payload as {
        layer2?: { immuneMatches: unknown[]; antibodies: Array<{ signature: string }> };
      };
      expect(payload.layer2?.immuneMatches.length).toBeGreaterThan(0);
      expect(payload.layer2?.antibodies[0]?.signature).toMatch(/^ey/);
      // the record's hash commits to the Layer 2 fields: editing them breaks the chain link
      expect(sha256Canonical(rec.evidence!.payload)).toBe(rec.evidence!.hash);
    });

    it("Q7: reports and orders move the seller's risk; arena counts stay separate from live ones", async () => {
      const arena = await db.merchantRisk.findUnique({
        where: { merchantId: `arena:${SELLER.id}` },
      });
      expect(arena?.orders).toBeGreaterThanOrEqual(4);
      const poi = createPoiClient({ baseUrl });
      await poi.reportOrder({ orderId: specific.orderId, reason: "it signed me up for a plan" });
      const after = await db.merchantRisk.findUnique({
        where: { merchantId: `arena:${SELLER.id}` },
      });
      expect(after!.reports).toBe((arena?.reports ?? 0) + 1);
      expect(await db.merchantRisk.findUnique({ where: { merchantId: SELLER.id } })).toBeNull();
      const rows = await poi.getMerchantRisks();
      expect(rows.find((r) => r.merchantId === SELLER.id)).toMatchObject({
        displayName: SELLER.displayName,
        risk: 0.2,
      });
      await expect(poi.reportOrder({ orderId: "nope", reason: "x" })).rejects.toMatchObject({
        status: 404,
      });
    });

    it("Q8: /calibration/run sets thresholds, the defender uses them, and the immune arm quotes them", async () => {
      const poi = createPoiClient({ baseUrl });
      const cal = await poi.runCalibration({ alpha: 0.5 });
      expect(cal.n).toBeGreaterThanOrEqual(1);
      expect(cal.lambdaVoid).toBeGreaterThanOrEqual(cal.lambdaAsk);
      expect((await poi.getLatestCalibration()).id).toBe(cal.id);
      expect((await poi.getDefender()).activeCalibrationId).toBe(cal.id);
      expect(Array.isArray(await poi.getCalibrationCurve())).toBe(true);
      const g = await genome("lookalike", seedListing("HUB-LOOK-01"));
      const t = await trial(g);
      lookalikeOrder = t.orderId!;
      const l2 = (await immuneArm(t.orderId!)).l2 as { calibration?: { calibrationId: string } };
      expect(l2.calibration?.calibrationId).toBe(cal.id);
      await expect(poi.runCalibration({ alpha: 0.0001 })).rejects.toMatchObject({ status: 422 });
    });

    it("the queue: an enqueued mint is minted and then promoted or rejected without help", async () => {
      await deps.immuneQueue.enqueueMint({
        orderId: lookalikeOrder,
        family: "lookalike",
        source: "report",
      });
      await deps.immuneQueue.close();
      const a = await db.antibody.findFirst({ where: { sourceOrderId: lookalikeOrder } });
      expect(a).not.toBeNull();
      expect(a!.state).not.toBe("CANDIDATE");
    });

    it("Q6: false hits, manual retirement, and pinned snapshots", async () => {
      const poi = createPoiClient({ baseUrl });
      // two human approvals of orders this antibody escalated
      for (const n of [1, 2]) {
        await recordHits(db, [
          {
            antibodyId: specific.antibodyId,
            orderId: `x-${n}`,
            verificationId: `fh-${RUN}-${n}`,
            kind: "minhash",
            similarity: 0.9,
            live: true,
            escalated: true,
          },
        ]);
        expect(await markFalseHits(db, `fh-${RUN}-${n}`)).toEqual([
          { antibodyId: specific.antibodyId, hits: n, falseHits: n },
        ]);
      }
      const detail = await poi.getAntibody(specific.antibodyId);
      expect(detail.recentHits.some((h) => h.falseHit)).toBe(true);
      expect(detail.sourceOrder?.orderId).toBe(specific.orderId);
      const liveAt = (await getDefender(db)).version;
      const retired = await poi.retireAntibody(specific.antibodyId);
      expect(retired.status).toBe("retired");
      expect((await snapshotDefender(db, liveAt)).antibodyIds).toContain(specific.antibodyId);
      expect(
        (await snapshotDefender(db, (await getDefender(db)).version)).antibodyIds,
      ).not.toContain(specific.antibodyId);
      await expect(poi.retireAntibody(specific.antibodyId)).rejects.toMatchObject({ status: 409 });
      expect((await poi.listAntibodies("retired")).some((a) => a.id === specific.antibodyId)).toBe(
        true,
      );
    });
  },
);
