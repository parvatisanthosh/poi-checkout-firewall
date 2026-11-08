// pnpm terms:ingest -- for each merchant in the registry, fetch {BAZAAR_URL}/merchants/:id/terms,
// chunk it, embed it (EMBEDDING_MODEL, if its key is set) and store it. Idempotent.
import { getEmbeddingModel, hasKeyFor } from "@poi/shared/llm";
import { env } from "../src/env";
import { disconnectPrisma, getPrisma } from "../src/lib/prisma";
import { ingestMerchantTerms } from "../src/verifier/terms-rag";

async function main() {
  const prisma = getPrisma();
  const model =
    env.EMBEDDING_MODEL && hasKeyFor(env.EMBEDDING_MODEL)
      ? getEmbeddingModel(env.EMBEDDING_MODEL)
      : undefined;
  console.log(
    model
      ? `Embedding with ${env.EMBEDDING_MODEL}`
      : "No embedding key: storing chunks for keyword retrieval only",
  );
  const merchants = await prisma.merchant.findMany();
  let total = 0;
  for (const m of merchants) {
    const url = `${env.BAZAAR_URL.replace(/\/+$/, "")}/merchants/${encodeURIComponent(m.id)}/terms`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        console.log(`  ${m.id}: no terms (${res.status})`);
        continue;
      }
      const n = await ingestMerchantTerms(prisma, m.id, await res.text(), model);
      total += n;
      console.log(`  ${m.id}: ${n} chunks`);
    } catch (err) {
      console.log(`  ${m.id}: Bazaar unreachable (${(err as Error).message})`);
    }
  }
  console.log(`Ingested ${total} chunks for ${merchants.length} merchants.`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
