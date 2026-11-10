// LSH banding for MinHash signatures (CONTRACTS-L2 5.2 step 4): 128 numbers -> 32 bands of 4.
// Two signatures are candidates when any band hash collides; a candidate is then confirmed
// with the exact estimated Jaccard. P(candidate) = 1 - (1 - s^4)^32.
import { createHash } from "node:crypto";
import { LSH_BANDS, MINHASH_SIZE } from "@poi/shared";

export const ROWS_PER_BAND = MINHASH_SIZE / LSH_BANDS; // 4

/** One stable hash per band. Includes the band index so equal rows in different bands don't collide. */
export function lshBands(minhash: number[]): string[] {
  if (minhash.length !== MINHASH_SIZE) {
    throw new Error(`MinHash must have ${MINHASH_SIZE} numbers, got ${minhash.length}`);
  }
  return Array.from({ length: LSH_BANDS }, (_, band) => {
    const rows = minhash.slice(band * ROWS_PER_BAND, (band + 1) * ROWS_PER_BAND).join(",");
    return createHash("sha256").update(`${band}|${rows}`).digest("hex").slice(0, 16);
  });
}

/** Estimated Jaccard similarity: the fraction of positions where two signatures agree. */
export function estimatedJaccard(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0)
    throw new Error("signatures must be the same non-zero length");
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}
