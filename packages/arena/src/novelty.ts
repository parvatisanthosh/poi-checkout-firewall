/**
 * Embedding computation and novelty calculation (CONTRACTS-L2 4.6).
 *
 * noveltyCos(text, eliteEmbeddings):
 * - embed with EMBEDDING_MODEL via the shared getModel / getEmbeddingModel
 * - return max cosine (0 if no elites) + the embedding
 */
import { embed } from "ai";
import { EMBEDDING_DIMS, getEmbeddingModel, hasKeyFor } from "@poi/shared/llm";

/** Deterministic pseudo-random 1536-dimensional hashing vector when API key is not present. */
function hashEmbedding(text: string, dims = EMBEDDING_DIMS): number[] {
  const vec = new Float64Array(dims);
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    let h1 = 0x811c9dc5;
    let h2 = 0x5bd1e995;
    for (let j = 0; j < w.length; j++) {
      const code = w.charCodeAt(j);
      h1 = Math.imul(h1 ^ code, 0x01000193);
      h2 = Math.imul(h2 ^ code, 0x5bd1e995);
    }
    const idx = Math.abs(h1) % dims;
    const sign = h2 % 2 === 0 ? 1 : -1;
    vec[idx] = (vec[idx] ?? 0) + sign;
  }

  // Also include character n-grams (3-grams) for subword coverage
  for (let i = 0; i < text.length - 2; i++) {
    const gram = text.slice(i, i + 3);
    let h = 0;
    for (let j = 0; j < 3; j++) h = (h * 31 + gram.charCodeAt(j)) | 0;
    const idx = Math.abs(h) % dims;
    vec[idx] = (vec[idx] ?? 0) + 0.5;
  }

  // L2-normalize
  let sumSq = 0;
  for (let i = 0; i < dims; i++) sumSq += vec[i]! * vec[i]!;
  const norm = Math.sqrt(sumSq) || 1;
  const out = new Array<number>(dims);
  for (let i = 0; i < dims; i++) out[i] = Math.round((vec[i]! / norm) * 100000) / 100000;
  return out;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  const sim = dot / denom;
  return Math.max(0, Math.min(1, Math.round(sim * 10000) / 10000));
}

export async function noveltyCos(
  text: string,
  eliteEmbeddings: number[][],
): Promise<{ cos: number; embedding: number[] }> {
  let embedding: number[];

  const embeddingModelId = process.env.EMBEDDING_MODEL ?? "openai:text-embedding-3-small";
  let canCall = false;
  try {
    canCall = hasKeyFor(embeddingModelId);
  } catch {
    canCall = false;
  }

  if (canCall) {
    try {
      const model = getEmbeddingModel(embeddingModelId);
      const res = await embed({ model, value: text });
      embedding = Array.from(res.embedding);
    } catch {
      embedding = hashEmbedding(text);
    }
  } else {
    embedding = hashEmbedding(text);
  }

  if (!eliteEmbeddings || eliteEmbeddings.length === 0) {
    return { cos: 0, embedding };
  }

  let maxCos = 0;
  for (const elite of eliteEmbeddings) {
    const sim = cosineSimilarity(embedding, elite);
    if (sim > maxCos) {
      maxCos = sim;
    }
  }

  return { cos: maxCos, embedding };
}
