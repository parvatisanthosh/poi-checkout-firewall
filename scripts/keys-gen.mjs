#!/usr/bin/env node
// pnpm keys:gen [--force] [--print]
// Generates an Ed25519 private JWK for POI_SIGNING_JWK and writes it into .env.
// Refuses to replace an existing key unless --force: rotating the key invalidates
// every mandate and evidence signature made with the old one.
import { createHash, generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const envPath = `${root}.env`;
const examplePath = `${root}.env.example`;
const force = process.argv.includes("--force");
const printOnly = process.argv.includes("--print");

const { privateKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });

// RFC 7638 thumbprint as kid: sha256 over the required public members in lexicographic order.
const thumbprintInput = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
const kid = createHash("sha256").update(thumbprintInput).digest("base64url");
const full = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d, kid, alg: "EdDSA", use: "sig" };
const line = `POI_SIGNING_JWK=${JSON.stringify(full)}`;

if (printOnly) {
  console.log(line);
  process.exit(0);
}

if (!existsSync(envPath)) {
  copyFileSync(examplePath, envPath);
  console.log("Created .env from .env.example");
}

const env = readFileSync(envPath, "utf8");
const existing = /^POI_SIGNING_JWK=(.+)$/m.exec(env);
if (existing && existing[1].trim() && !force) {
  console.log(
    "POI_SIGNING_JWK is already set in .env -- leaving it alone (use --force to rotate).",
  );
  process.exit(0);
}

const next = /^POI_SIGNING_JWK=.*$/m.test(env)
  ? env.replace(/^POI_SIGNING_JWK=.*$/m, () => line)
  : `${env.replace(/\n?$/, "\n")}${line}\n`;
writeFileSync(envPath, next);
console.log(`Wrote POI_SIGNING_JWK to .env (kid ${kid}). Public x: ${jwk.x}`);
