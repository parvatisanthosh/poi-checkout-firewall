// Text fingerprints for immune memory (CONTRACTS-L2 5.2 steps 1-3).
//   normalize: NFKC, lowercase, collapse whitespace, every digit -> '#'
//   shingle:   overlapping 5-word windows; text under 5 words falls back to 5-char windows
//   MinHash:   128 hash functions h_i(x) = (a_i * x + b_i) mod p over the 32-bit murmur3 of each
//              shingle, p = 4294967311 (the first prime above 2^32); keep the minimum per function.
// The a_i / b_i come from a fixed-seed generator, so they are the same constants on every machine
// and every restart: a signature minted today matches one computed next week.
import { MINHASH_SIZE } from "@poi/shared";

/**
 * NFKC, lowercase, whitespace collapsed, every run of digits -> one '#'. Runs, not single digits,
 * so "$14.99/mo" and "$9.49/mo" both become "$#.#/mo" (the plan's intent: a price change must not
 * dodge an antibody). Idempotent on listingText() output, whose digits are already '#'.
 */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\d+/g, "#")
    .replace(/#+/g, "#")
    .trim();
}

export const SHINGLE_WORDS = 5;

/** Distinct shingles of already-normalized text. */
export function shingles(text: string): string[] {
  const words = text.split(" ").filter(Boolean);
  const out = new Set<string>();
  if (words.length >= SHINGLE_WORDS) {
    for (let i = 0; i + SHINGLE_WORDS <= words.length; i++)
      out.add(words.slice(i, i + SHINGLE_WORDS).join(" "));
  } else {
    const t = words.join(" ");
    if (t.length <= SHINGLE_WORDS) {
      if (t) out.add(t);
    } else
      for (let i = 0; i + SHINGLE_WORDS <= t.length; i++) out.add(t.slice(i, i + SHINGLE_WORDS));
  }
  return [...out];
}

/** 32-bit murmur3 (x86_32) of the string's UTF-8 bytes. */
export function murmur3(key: string, seed = 0): number {
  const bytes = new TextEncoder().encode(key);
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h = seed >>> 0;
  const nblocks = bytes.length >>> 2;
  for (let i = 0; i < nblocks; i++) {
    const j = i * 4;
    let k = bytes[j]! | (bytes[j + 1]! << 8) | (bytes[j + 2]! << 16) | (bytes[j + 3]! << 24);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  const tail = nblocks * 4;
  const rem = bytes.length & 3;
  if (rem) {
    let k = 0;
    if (rem === 3) k ^= bytes[tail + 2]! << 16;
    if (rem >= 2) k ^= bytes[tail + 1]! << 8;
    k ^= bytes[tail]!;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
  }
  h ^= bytes.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export const MINHASH_PRIME = 4294967311n;

/** The 128 (a_i, b_i) pairs: a in [1, p-1], b in [0, p-1], from a fixed seed. */
const COEFFICIENTS: Array<[bigint, bigint]> = (() => {
  let s = 0x504f4931; // "POI1"
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return BigInt((t ^ (t >>> 14)) >>> 0);
  };
  const wide = () => (next() << 32n) | next();
  return Array.from({ length: MINHASH_SIZE }, () => [
    (wide() % (MINHASH_PRIME - 1n)) + 1n,
    wide() % MINHASH_PRIME,
  ]);
})();

/**
 * 128-number MinHash signature of a shingle set. Each minimum (< p, so < 2^32 + 15) is stored as a
 * signed 32-bit integer (Postgres int4): x mod 2^32 reinterpreted. Only equality matters, and
 * values in [2^32, p) are 15 in 4.29 billion, so the wrap never changes a comparison in practice.
 */
export function minhash(shingleSet: string[]): number[] {
  if (shingleSet.length === 0) throw new Error("minhash: no shingles (empty text)");
  const xs = shingleSet.map((s) => BigInt(murmur3(s)));
  return COEFFICIENTS.map(([a, b]) => {
    let min = MINHASH_PRIME;
    for (const x of xs) {
      const h = (a * x + b) % MINHASH_PRIME;
      if (h < min) min = h;
    }
    return Number(min & 0xffffffffn) | 0;
  });
}

/** normalize -> shingle -> MinHash, plus the shingle count (for containment estimates). */
export function fingerprint(text: string): { minhash: number[]; shingleCount: number } {
  const set = shingles(normalizeText(text));
  return { minhash: minhash(set), shingleCount: set.length };
}

/**
 * Estimated containment |A n B| / |A| from the Jaccard estimate and both set sizes:
 * |A n B| = J (|A| + |B|) / (1 + J). Used by the promotion gate, where a short generic antibody
 * fully contained in a long benign listing has a low Jaccard but must still be rejected.
 */
export function estimatedContainment(jaccard: number, sizeA: number, sizeB: number): number {
  if (sizeA <= 0) return 0;
  return Math.min(1, (jaccard * (sizeA + sizeB)) / ((1 + jaccard) * sizeA));
}
