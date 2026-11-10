import { EMBEDDING_DIMS } from "@poi/shared/llm";

/** pgvector literal "[0.1,0.2,...]" from a 1536-dim embedding. Rejects wrong sizes and NaN/Infinity. */
export function toVectorLiteral(v: number[]): string {
  if (v.length !== EMBEDDING_DIMS)
    throw new Error(`embedding must have ${EMBEDDING_DIMS} dims, got ${v.length}`);
  if (!v.every(Number.isFinite)) throw new Error("embedding contains a non-finite number");
  return `[${v.join(",")}]`;
}

/** pgvector text output "[0.1,0.2,...]" -> number[]. */
export function parseVector(text: string): number[] {
  return text
    .replace(/^\[|\]$/g, "")
    .split(",")
    .filter(Boolean)
    .map(Number);
}
