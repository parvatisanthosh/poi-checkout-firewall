// The POI signing key (Ed25519). Signs intent JWSs (P3) and evidence records (P7).
// Loaded from POI_SIGNING_JWK (a private JWK written by `pnpm keys:gen`). Never log it.
import { calculateJwkThumbprint, importJWK } from "jose";
import { z } from "zod";
import type { PublicJwk } from "@poi/shared";
import { env } from "../env";
import { HttpError } from "../lib/errors";

const PrivateJwk = z.object({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: z.string().min(1),
  d: z.string().min(1),
  kid: z.string().optional(),
});

export type JoseKey = Awaited<ReturnType<typeof importJWK>>;

export interface SigningKey {
  kid: string;
  privateKey: JoseKey;
  publicKey: JoseKey;
  publicJwk: PublicJwk;
}

export async function loadSigningKey(raw: string): Promise<SigningKey> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("POI_SIGNING_JWK is not valid JSON (run pnpm keys:gen)");
  }
  const parsed = PrivateJwk.safeParse(json);
  if (!parsed.success)
    throw new Error("POI_SIGNING_JWK is not an Ed25519 private JWK (run pnpm keys:gen)");
  const { kty, crv, x, d } = parsed.data;
  const kid = parsed.data.kid ?? (await calculateJwkThumbprint({ kty, crv, x }));
  const publicJwk: PublicJwk = { kty, crv, x, kid, alg: "EdDSA", use: "sig" };
  return {
    kid,
    privateKey: await importJWK({ kty, crv, x, d }, "EdDSA"),
    publicKey: await importJWK({ kty, crv, x }, "EdDSA"),
    publicJwk,
  };
}

let cached: Promise<SigningKey> | undefined;

/** The key from env, loaded once. 503 when it isn't configured. */
export function getSigningKey(): Promise<SigningKey> {
  if (!env.POI_SIGNING_JWK) {
    return Promise.reject(
      new HttpError(503, "SIGNING_KEY_MISSING", "POI_SIGNING_JWK is not set; run pnpm keys:gen"),
    );
  }
  cached ??= loadSigningKey(env.POI_SIGNING_JWK).catch((err: unknown) => {
    cached = undefined;
    throw err;
  });
  return cached;
}
