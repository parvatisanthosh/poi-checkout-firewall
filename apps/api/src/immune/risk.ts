// Merchant risk (CONTRACTS-L2 5.3): a Beta prior that assumes most merchants are fine (mean 0.2).
//   risk = (voids + reports + 1) / (orders + 5)
// New merchant 0/0 -> 0.20; 1 bad of 1 -> 0.33; 2 of 2 -> 0.43 (> 0.35: ASK_HUMAN); 3 of 20 -> 0.16.
// Dry-run (arena) orders count under "arena:<merchantId>", so attacks in the arena never raise
// a real merchant's live risk.
import type { CheckResult, Merchant, MerchantRiskRow, MerchantRiskSnapshot } from "@poi/shared";
import type { Prisma, PrismaClient } from "../lib/prisma";

type Db = PrismaClient | Prisma.TransactionClient;

export const ARENA_RISK_PREFIX = "arena:";

export const riskScore = (r: { voids: number; reports: number; orders: number }) =>
  (r.voids + r.reports + 1) / (r.orders + 5);

/** The MerchantRisk row an order counts under. */
export const riskKey = (merchantId: string, mode: "LIVE" | "DRY_RUN") =>
  mode === "DRY_RUN" ? `${ARENA_RISK_PREFIX}${merchantId}` : merchantId;

export async function getRisk(db: Db, key: string): Promise<MerchantRiskSnapshot> {
  const r = await db.merchantRisk.findUnique({ where: { merchantId: key } });
  const counts = { voids: r?.voids ?? 0, reports: r?.reports ?? 0, orders: r?.orders ?? 0 };
  return { merchantId: key, risk: riskScore(counts), ...counts };
}

export async function bumpRisk(db: Db, key: string, field: "orders" | "voids" | "reports") {
  await db.merchantRisk.upsert({
    where: { merchantId: key },
    create: { merchantId: key, [field]: 1 },
    update: { [field]: { increment: 1 } },
  });
}

/** A report against an order ("this wasn't what I asked for", or the arena oracle's). */
export async function recordReport(db: Db, orderId: string): Promise<void> {
  const o = await db.orderRecord.findUnique({
    where: { id: orderId },
    select: { merchantId: true, mode: true },
  });
  if (o) await bumpRisk(db, riskKey(o.merchantId, o.mode), "reports");
}

/** The risk check (stage semantic): fail/medium above the threshold, else pass. Confidence = risk. */
export function riskCheck(r: MerchantRiskSnapshot, threshold: number): CheckResult {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const bad = r.voids + r.reports;
  const history = `${bad} problem order${bad === 1 ? "" : "s"} in ${r.orders}`;
  return r.risk > threshold
    ? {
        check: "risk",
        stage: "semantic",
        outcome: "fail",
        severity: "medium",
        expected: `risk at most ${pct(threshold)}`,
        actual: pct(r.risk),
        reason: `This seller has a history of problem orders (${history}), so a person should confirm.`,
        confidence: r.risk,
        latencyMs: 0,
      }
    : {
        check: "risk",
        stage: "semantic",
        outcome: "pass",
        severity: "low",
        reason: `Seller history looks fine (${history}).`,
        confidence: r.risk,
        latencyMs: 0,
      };
}

/** GET /api/immune/merchants: every registry merchant plus any live merchant with history. */
export async function listMerchantRisks(db: Db, registry: Merchant[]): Promise<MerchantRiskRow[]> {
  const rows = await db.merchantRisk.findMany({
    where: { NOT: { merchantId: { startsWith: ARENA_RISK_PREFIX } } },
  });
  const byId = new Map(rows.map((r) => [r.merchantId, r]));
  const ids = new Set([...registry.map((m) => m.id), ...rows.map((r) => r.merchantId)]);
  return [...ids]
    .map((id) => {
      const r = byId.get(id);
      const counts = { voids: r?.voids ?? 0, reports: r?.reports ?? 0, orders: r?.orders ?? 0 };
      return {
        merchantId: id,
        displayName: registry.find((m) => m.id === id)?.displayName ?? id,
        risk: riskScore(counts),
        ...counts,
      };
    })
    .sort((a, b) => b.risk - a.risk || a.merchantId.localeCompare(b.merchantId));
}
