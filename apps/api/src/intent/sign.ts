import { randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { IntentSpec, type IntentSpecInput } from "@poi/shared";
import { sha256Canonical } from "../evidence/canonical";
import type { JoseKey, SigningKey } from "../evidence/keys";

export const INTENT_JWS_TYPE = "poi-intent+jwt";

export interface IntentJwsPayload {
  iss: "poi";
  intentId: string;
  specHash: string;
  iat: number;
}

export function newIntentId(): string {
  return `int_${randomBytes(12).toString("base64url")}`;
}

/**
 * specHash = sha256(RFC 8785 canonical JSON of the spec with defaults applied). Parsing first
 * means `{ quantity: 1 }` and an omitted quantity hash the same: the hash is of what the spec
 * *means*, not of how the client happened to serialize it.
 */
export function hashSpec(spec: IntentSpec | IntentSpecInput): string {
  return sha256Canonical(IntentSpec.parse(spec));
}

/** Compact JWS (EdDSA), payload { iss: "poi", intentId, specHash, iat }. */
export async function signIntent(
  key: SigningKey,
  claims: { intentId: string; specHash: string; issuedAt?: Date },
): Promise<string> {
  const iat = Math.floor((claims.issuedAt ?? new Date()).getTime() / 1000);
  return new SignJWT({ intentId: claims.intentId, specHash: claims.specHash })
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid, typ: INTENT_JWS_TYPE })
    .setIssuer("poi")
    .setIssuedAt(iat)
    .sign(key.privateKey);
}

/** Verifies signature, issuer and type; returns the payload. Throws on any mismatch. */
export async function verifyIntentJws(jws: string, publicKey: JoseKey): Promise<IntentJwsPayload> {
  const { payload } = await jwtVerify(jws, publicKey, {
    issuer: "poi",
    typ: INTENT_JWS_TYPE,
    algorithms: ["EdDSA"],
  });
  if (typeof payload.intentId !== "string" || typeof payload.specHash !== "string") {
    throw new Error("intent JWS is missing intentId/specHash");
  }
  return {
    iss: "poi",
    intentId: payload.intentId,
    specHash: payload.specHash,
    iat: payload.iat ?? 0,
  };
}
