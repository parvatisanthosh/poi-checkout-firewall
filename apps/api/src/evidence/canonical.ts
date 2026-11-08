import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

/** RFC 8785 (JCS) canonical JSON: same value -> same bytes, regardless of key order. */
export function canonicalJson(value: unknown): string {
  const out = canonicalize(value);
  if (out === undefined) throw new Error("value cannot be canonicalized");
  return out;
}

/** Lowercase hex SHA-256 of the canonical JSON. */
export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
