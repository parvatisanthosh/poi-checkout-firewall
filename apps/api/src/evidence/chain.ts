// P8: append-only, hash-chained, signed evidence.
//   payload = { ...facts, prevHash }      hash = sha256(RFC 8785(payload))
//   jws     = EdDSA JWS over { hash, seq } genesis prevHash = 64 zeros
// Appends run inside a transaction holding a Postgres advisory lock, so two workers can never
// both read the same tail and fork the chain.
import { jwtVerify, SignJWT } from "jose";
import type { PrismaClient } from "../lib/prisma";
import { sha256Canonical } from "./canonical";
import type { JoseKey, SigningKey } from "./keys";

export const GENESIS_HASH = "0".repeat(64);
export const EVIDENCE_JWS_TYPE = "poi-evidence+jwt";
const CHAIN_LOCK = 0x504f49; // "POI"

export interface EvidenceFacts {
  kind: "verification" | "decision";
  verificationId: string;
  intentId: string;
  specHash: string;
  mandateJws: string;
  orderId: string;
  /** sha256 of the canonical raw PayPal order POI judged. */
  orderSnapshotHash: string | null;
  normalized: unknown;
  checks: unknown;
  verdict: string | null;
  humanDecision?: string;
  settlement: { action: string; paypalStatus?: string };
  /**
   * Layer 2 (CONTRACTS-L2 4.4 / Q9): immune matches, merchant risk, calibration, defender version,
   * counterfactual. Present only in records of Layer 2 verifications, so older records and their
   * hashes are unchanged.
   */
  layer2?: unknown;
  createdAt: string;
}

export interface StoredEvidence {
  seq: number;
  verificationId: string;
  prevHash: string;
  hash: string;
  payload: unknown;
  jws: string;
  createdAt: Date;
}

async function signLink(key: SigningKey, hash: string, seq: number): Promise<string> {
  return new SignJWT({ hash, seq })
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid, typ: EVIDENCE_JWS_TYPE })
    .setIssuer("poi")
    .setIssuedAt()
    .sign(key.privateKey);
}

export async function appendEvidence(
  prisma: PrismaClient,
  key: SigningKey,
  facts: EvidenceFacts,
): Promise<StoredEvidence> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CHAIN_LOCK})`;
    const tail = await tx.evidenceRecord.findFirst({ orderBy: { seq: "desc" } });
    const prevHash = tail?.hash ?? GENESIS_HASH;
    // seq is assigned here (under the lock) rather than by the sequence, so the signed seq is
    // known before the row is written and there are never gaps.
    const seq = (tail?.seq ?? 0) + 1;
    const payload = { ...facts, prevHash };
    const hash = sha256Canonical(payload);
    const jws = await signLink(key, hash, seq);
    return tx.evidenceRecord.create({
      data: {
        seq,
        verificationId: facts.verificationId,
        prevHash,
        hash,
        payload: payload as object,
        jws,
      },
    });
  });
}

export interface ChainReport {
  chainValid: boolean;
  signaturesValid: boolean;
  /** First seq whose hash, link or signature doesn't check out. */
  brokenAt?: number;
  checked: number;
}

/** Recompute every hash and link, verify every JWS, up to and including `upToSeq`. */
export async function validateChain(
  prisma: PrismaClient,
  publicKey: JoseKey,
  upToSeq?: number,
): Promise<ChainReport> {
  const rows = await prisma.evidenceRecord.findMany({
    where: upToSeq === undefined ? {} : { seq: { lte: upToSeq } },
    orderBy: { seq: "asc" },
  });
  return validateRows(rows, publicKey);
}

/** Does this record's JWS verify and bind its hash + seq? */
export async function verifyEvidenceJws(
  row: Pick<StoredEvidence, "jws" | "hash" | "seq">,
  publicKey: JoseKey,
): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(row.jws, publicKey, {
      issuer: "poi",
      typ: EVIDENCE_JWS_TYPE,
      algorithms: ["EdDSA"],
    });
    return payload.hash === row.hash && payload.seq === row.seq;
  } catch {
    return false;
  }
}

export async function validateRows(
  rows: StoredEvidence[],
  publicKey: JoseKey,
): Promise<ChainReport> {
  let prev = GENESIS_HASH;
  let chainValid = true;
  let signaturesValid = true;
  let brokenAt: number | undefined;
  for (const row of rows) {
    const payload = row.payload as { prevHash?: unknown };
    const linked = row.prevHash === prev && payload?.prevHash === prev;
    const hashed = sha256Canonical(row.payload) === row.hash;
    const signed = await verifyEvidenceJws(row, publicKey);
    if (!(linked && hashed)) chainValid = false;
    if (!signed) signaturesValid = false;
    // brokenAt tracks the hash chain; signatures are reported separately (older records may be
    // signed by a rotated key).
    if ((!linked || !hashed) && brokenAt === undefined) brokenAt = row.seq;
    prev = row.hash;
  }
  return {
    chainValid,
    signaturesValid,
    ...(brokenAt !== undefined ? { brokenAt } : {}),
    checked: rows.length,
  };
}
