import { exportJWK, generateKeyPair } from "jose";
import { loadSigningKey, type SigningKey } from "../src/evidence/keys";

/** A fresh Ed25519 signing key, loaded the same way as POI_SIGNING_JWK. */
export async function testSigningKey(): Promise<SigningKey> {
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  return loadSigningKey(JSON.stringify(await exportJWK(privateKey)));
}
