// The promotion gate's benign set (IMMUNE_BENIGN_SET, built by the teammate in bench/evolved): 40
// honest listings, each with the normalized order buying it. Loaded once and turned into probes
// with the same code the verifier uses, so "matches a benign item" means exactly what a live
// match would mean. The listing side uses listingText() (CONTRACTS-L2 4.6), the canonical text.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { listingText } from "@poi/arena";
import type { EmbeddingModel } from "ai";
import { embedMany } from "ai";
import { z } from "zod";
import { BazaarProduct, NormalizedOrder, type Merchant } from "@poi/shared";
import { EMBEDDING_DIMS } from "@poi/shared/llm";
import { buildProbe, type Probe } from "./match";

const BenignItem = z.object({
  sku: z.string(),
  merchantId: z.string(),
  product: BazaarProduct,
  normalizedOrder: NormalizedOrder,
});
export type BenignItem = z.infer<typeof BenignItem>;

export interface BenignProbe {
  sku: string;
  merchantId: string;
  probe: Probe;
}

/** Resolve a repo-relative path from the API's cwd (apps/api in dev) or the repo root. */
export function resolveDataPath(p: string): string {
  if (isAbsolute(p)) return p;
  const candidates = [resolve(process.cwd(), p), resolve(process.cwd(), "../..", p)];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
}

export function loadBenignItems(path: string): BenignItem[] {
  const file = resolveDataPath(path);
  if (!existsSync(file)) throw new Error(`IMMUNE_BENIGN_SET not found: ${file}`);
  return z.array(BenignItem).parse(JSON.parse(readFileSync(file, "utf8")));
}

const cache = new Map<string, Promise<BenignProbe[]>>();

/** Probes for the benign set, embedded when a model is available. Cached per path and model. */
export function benignProbes(
  path: string,
  registry: Merchant[],
  embeddingModel?: EmbeddingModel,
): Promise<BenignProbe[]> {
  const key = `${path}|${embeddingModel ? "emb" : "noemb"}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = (async () => {
      const items = loadBenignItems(path);
      const evidence = items.map((it) => ({
        order: it.normalizedOrder,
        pageText: listingText(it.product),
      }));
      let embeddings: Array<number[] | undefined> = items.map(() => undefined);
      if (embeddingModel) {
        const texts = evidence.map((e) => buildProbe(e, registry).text.slice(0, 8000));
        const res = await embedMany({ model: embeddingModel, values: texts });
        embeddings = res.embeddings.map((e) => (e.length === EMBEDDING_DIMS ? e : undefined));
      }
      return items.map((it, i) => ({
        sku: it.sku,
        merchantId: it.merchantId,
        probe: buildProbe(evidence[i]!, registry, embeddings[i]),
      }));
    })();
    hit.catch(() => cache.delete(key));
    cache.set(key, hit);
  }
  return hit;
}

/** Tests: forget cached probes (e.g. after changing the registry). */
export const clearBenignCache = () => cache.clear();
