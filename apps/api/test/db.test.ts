// Integration test against the real Postgres. Opt in: RUN_DB_TESTS=1 (needs docker compose up
// and pnpm db:migrate). CI runs it with Postgres + Redis service containers.
import { afterAll, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/lib/prisma";

describe.runIf(process.env.RUN_DB_TESTS === "1")("database", () => {
  afterAll(() => disconnectPrisma());

  it("has the pgvector extension and the tables", async () => {
    const prisma = getPrisma();
    const ext = await prisma.$queryRaw<
      { extname: string }[]
    >`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    expect(ext).toHaveLength(1);
    await expect(prisma.merchant.count()).resolves.toBeTypeOf("number");
  });

  it("round-trips a merchant and a vector-typed terms chunk", async () => {
    const prisma = getPrisma();
    const id = `test-${Date.now()}`;
    await prisma.merchant.create({ data: { id, displayName: "Test Merchant" } });
    const vec = `[${Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
    await prisma.$executeRaw`INSERT INTO "TermsChunk" (id, "merchantId", text, embedding) VALUES (${`${id}-c`}, ${id}, 'refunds within 30 days', ${vec}::vector)`;
    const rows = await prisma.$queryRaw<
      { distance: number }[]
    >`SELECT embedding <=> ${vec}::vector AS distance FROM "TermsChunk" WHERE "merchantId" = ${id}`;
    expect(rows[0]?.distance).toBeCloseTo(0);
    await prisma.termsChunk.deleteMany({ where: { merchantId: id } });
    await prisma.merchant.delete({ where: { id } });
  });
});
