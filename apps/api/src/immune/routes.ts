// Immune memory, calibration and defender endpoints (CONTRACTS-L2 4.4).
import { Router } from "express";
import {
  AntibodyDetail,
  AntibodyList,
  AntibodyStatus,
  AntibodySummary,
  CalibrationCurve,
  CalibrationResult,
  CalibrationRunRequest,
  DefenderInfo,
  ImmuneReportRequest,
  ImmuneReportResponse,
  MerchantRiskList,
  NormalizedOrder,
} from "@poi/shared";
import { z } from "zod";
import type { AppDeps } from "../app";
import { calibrationCurve, runCalibration } from "../calibration/calibrate.job";
import { latestCalibration } from "../calibration/calibration.repo";
import { NeedMoreData } from "../calibration/crc";
import { env } from "../env";
import { HttpError } from "../lib/errors";
import { handle } from "../lib/handler";
import { getAntibody, getAntibodySummary, listAntibodies, recentHits } from "./antibody.repo";
import { getDefender } from "./defender";
import { computeFeatures } from "./features";
import { buildProbe } from "./match";
import { familyFromReason, findMergeTarget, loadOrderEvidence } from "./mint.job";
import { retire } from "./promote.job";
import { listMerchantRisks, recordReport } from "./risk";

const Id = z.object({ id: z.string().min(1).max(64) });
type Deps = Pick<AppDeps, "prisma" | "logger" | "enqueueMint" | "arenaEmitter">;

export function immuneRouter(deps: Deps): Router {
  const r = Router();
  const calDeps = () => ({
    prisma: deps.prisma,
    emitter: deps.arenaEmitter,
    benignVoidQuantile: env.CRC_BENIGN_VOID_QUANTILE,
  });

  r.get(
    "/immune/antibodies",
    handle(
      { query: z.object({ state: AntibodyStatus.optional() }), response: AntibodyList },
      ({ query }) => listAntibodies(deps.prisma(), query.state),
    ),
  );

  r.get(
    "/immune/antibodies/:id",
    handle({ params: Id, response: AntibodyDetail }, async ({ params }) => {
      const db = deps.prisma();
      const antibody = await getAntibodySummary(db, params.id);
      if (!antibody)
        throw new HttpError(404, "ANTIBODY_NOT_FOUND", `Antibody ${params.id} not found`);
      const o = await db.orderRecord.findUnique({ where: { id: antibody.sourceOrderId } });
      const n = NormalizedOrder.safeParse(o?.normalized);
      const merchant = n.success
        ? await db.merchant.findUnique({ where: { id: n.data.merchantId } })
        : null;
      return {
        antibody,
        recentHits: await recentHits(db, params.id),
        sourceOrder:
          o && n.success
            ? {
                orderId: o.id,
                merchantId: n.data.merchantId,
                merchantDisplayName: merchant?.displayName ?? n.data.merchantDisplayName,
                total: n.data.total,
                lineNames: n.data.lines.map((l) => l.name),
              }
            : null,
      };
    }),
  );

  r.post(
    "/immune/antibodies/:id/retire",
    handle({ params: Id, response: AntibodySummary }, async ({ params }) => {
      const db = deps.prisma();
      const a = await getAntibody(db, params.id);
      if (!a) throw new HttpError(404, "ANTIBODY_NOT_FOUND", `Antibody ${params.id} not found`);
      if (a.status !== "active")
        throw new HttpError(409, "ANTIBODY_NOT_ACTIVE", `Antibody ${params.id} is ${a.status}`);
      await retire(db, a.id, "manual");
      return (await getAntibodySummary(db, a.id))!;
    }),
  );

  // "This wasn't what I asked for." Counts against the seller, then either an existing antibody
  // already covers the order (returned) or minting is queued.
  r.post(
    "/immune/report",
    handle({ body: ImmuneReportRequest, response: ImmuneReportResponse }, async ({ body }) => {
      const db = deps.prisma();
      const order = await db.orderRecord.findUnique({
        where: { id: body.orderId },
        select: { id: true },
      });
      if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", `Order ${body.orderId} not found`);
      const ev = await loadOrderEvidence(db, body.orderId);
      if (!ev)
        throw new HttpError(409, "ORDER_NOT_VERIFIED", "This order hasn't been verified yet");
      await recordReport(db, body.orderId);
      const registry = await db.merchant.findMany();
      const merged = await findMergeTarget(db, buildProbe(ev, registry));
      if (merged) return { antibodyId: merged };
      const family = familyFromReason(body.reason, computeFeatures(ev, registry));
      if (family) await deps.enqueueMint({ orderId: body.orderId, family, source: "report" });
      else
        deps.logger.info(
          { orderId: body.orderId },
          "immune report: no recognisable trick, not minted",
        );
      return {};
    }),
  );

  r.get(
    "/immune/merchants",
    handle({ response: MerchantRiskList }, async () => {
      const db = deps.prisma();
      return listMerchantRisks(db, await db.merchant.findMany());
    }),
  );

  r.get(
    "/defender",
    handle({ response: DefenderInfo }, () => getDefender(deps.prisma())),
  );

  r.post(
    "/calibration/run",
    handle({ body: CalibrationRunRequest, response: CalibrationResult }, async ({ body }) => {
      try {
        return await runCalibration(calDeps(), body.alpha);
      } catch (err) {
        if (err instanceof NeedMoreData) throw new HttpError(422, "NEED_MORE_DATA", err.message);
        throw err;
      }
    }),
  );

  r.get(
    "/calibration/latest",
    handle({ response: CalibrationResult }, async () => {
      const c = await latestCalibration(deps.prisma());
      if (!c) throw new HttpError(404, "NO_CALIBRATION", "No calibration has been run yet");
      return c;
    }),
  );

  r.get(
    "/calibration/curve",
    handle({ response: CalibrationCurve }, () => calibrationCurve(calDeps())),
  );

  return r;
}
