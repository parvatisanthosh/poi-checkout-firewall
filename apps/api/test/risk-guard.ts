// Tests that verify orders for the real demo merchants also move their MerchantRisk counters
// (CONTRACTS-L2 5.3). Snapshot those rows before and put them back after, so a dev database's
// demo sellers don't drift toward ASK_HUMAN every time the suite runs. Only the given keys are
// touched, so concurrent test files with their own keys are unaffected.
import type { PrismaClient } from "../src/lib/prisma";

export async function preserveMerchantRisk(db: PrismaClient, keys: string[]) {
  const before = await db.merchantRisk.findMany({ where: { merchantId: { in: keys } } });
  return async function restore() {
    await db.merchantRisk.deleteMany({ where: { merchantId: { in: keys } } });
    for (const r of before)
      await db.merchantRisk.create({
        data: { merchantId: r.merchantId, voids: r.voids, reports: r.reports, orders: r.orders },
      });
  };
}
