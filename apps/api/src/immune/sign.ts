// Antibodies are signed like everything else POI asserts: an EdDSA JWS (Layer 1 signing key) over
// the RFC 8785 canonical JSON of what the antibody claims. Anyone with the public JWK can check
// that an antibody wasn't edited after it was minted. The signed claims leave out what changes
// legitimately later (status, counters, the version its promotion created).
import { compactVerify, CompactSign } from "jose";
import type { Antibody } from "@poi/shared";
import { canonicalJson } from "../evidence/canonical";
import type { JoseKey, SigningKey } from "../evidence/keys";

export const ANTIBODY_JWS_TYPE = "poi-antibody+jws";

export type AntibodyClaims = Pick<
  Antibody,
  "family" | "sourceOrderId" | "minhash" | "features" | "skeleton" | "action"
>;

export const antibodyClaims = (a: AntibodyClaims): AntibodyClaims => ({
  family: a.family,
  sourceOrderId: a.sourceOrderId,
  minhash: a.minhash,
  features: a.features,
  skeleton: a.skeleton,
  action: a.action,
});

export async function signAntibody(key: SigningKey, claims: AntibodyClaims): Promise<string> {
  return new CompactSign(new TextEncoder().encode(canonicalJson(antibodyClaims(claims))))
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid, typ: ANTIBODY_JWS_TYPE })
    .sign(key.privateKey);
}

/** True when the antibody's signature is valid for `publicKey` and covers exactly its claims. */
export async function verifyAntibodySignature(a: Antibody, publicKey: JoseKey): Promise<boolean> {
  try {
    const { payload, protectedHeader } = await compactVerify(a.signature, publicKey, {
      algorithms: ["EdDSA"],
    });
    return (
      protectedHeader.typ === ANTIBODY_JWS_TYPE &&
      new TextDecoder().decode(payload) === canonicalJson(antibodyClaims(a))
    );
  } catch {
    return false;
  }
}
