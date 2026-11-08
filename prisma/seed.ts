// pnpm db:seed  (prisma db seed) -- upserts the merchant registry. Safe to run repeatedly.
import { fileURLToPath } from "node:url";
import { loadMerchantRegistry } from "../apps/api/src/db/merchant-registry";
import { env } from "../apps/api/src/env";
import { disconnectPrisma, getPrisma } from "../apps/api/src/lib/prisma";

const merchantsJsonPath = fileURLToPath(
  new URL("../apps/bazaar/data/merchants.json", import.meta.url),
);

async function main() {
  const { source, merchants } = await loadMerchantRegistry({
    merchantsJsonPath,
    bazaarUrl: env.BAZAAR_URL,
  });
  const prisma = getPrisma();
  await prisma.$transaction(
    merchants.map((m) =>
      prisma.merchant.upsert({
        where: { id: m.id },
        create: m,
        update: { displayName: m.displayName, verified: m.verified },
      }),
    ),
  );
  const verified = merchants.filter((m) => m.verified).length;
  console.log(`Seeded ${merchants.length} merchants (${verified} verified) from ${source}.`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
