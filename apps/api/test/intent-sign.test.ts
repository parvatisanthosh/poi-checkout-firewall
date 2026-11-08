import { describe, expect, it } from "vitest";
import { IntentMandate, IntentSpec } from "@poi/shared";
import { demoSpec } from "@poi/shared/fixtures";
import { canonicalJson } from "../src/evidence/canonical";
import { loadSigningKey } from "../src/evidence/keys";
import { buildMandate, describeSpec } from "../src/intent/mandate";
import { hashSpec, signIntent, verifyIntentJws } from "../src/intent/sign";
import { testSigningKey } from "./helpers";

describe("canonical JSON + spec hash", () => {
  it("is independent of key order and of omitted defaults", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    const minimal = {
      version: "poi.intent/1" as const,
      rawText: "a hub",
      category: "usb-c hub",
      maxTotal: { currency: "USD", value: "40.00" },
    };
    const explicit = { ...IntentSpec.parse(minimal) };
    const reordered = Object.fromEntries(Object.entries(explicit).reverse());
    expect(hashSpec(minimal)).toBe(hashSpec(explicit));
    expect(hashSpec(minimal)).toBe(hashSpec(reordered as typeof explicit));
    expect(hashSpec(minimal)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when anything meaningful changes", () => {
    expect(hashSpec(demoSpec)).not.toBe(hashSpec({ ...demoSpec, oneTimeOnly: false }));
    expect(hashSpec(demoSpec)).not.toBe(
      hashSpec({ ...demoSpec, maxTotal: { currency: "USD", value: "40.01" } }),
    );
  });
});

describe("intent JWS", () => {
  it("round-trips and binds intentId + specHash", async () => {
    const key = await testSigningKey();
    const specHash = hashSpec(demoSpec);
    const jws = await signIntent(key, { intentId: "int_1", specHash });
    expect(jws.split(".")).toHaveLength(3);
    const header = JSON.parse(Buffer.from(jws.split(".")[0]!, "base64url").toString());
    expect(header).toMatchObject({ alg: "EdDSA", kid: key.kid });
    expect(await verifyIntentJws(jws, key.publicKey)).toMatchObject({
      iss: "poi",
      intentId: "int_1",
      specHash,
    });
  });

  it("rejects a tampered payload or a different key", async () => {
    const key = await testSigningKey();
    const jws = await signIntent(key, { intentId: "int_1", specHash: "a".repeat(64) });
    const [h, , s] = jws.split(".");
    const forged = Buffer.from(
      JSON.stringify({ iss: "poi", intentId: "int_1", specHash: "b".repeat(64), iat: 1 }),
    ).toString("base64url");
    await expect(verifyIntentJws(`${h}.${forged}.${s}`, key.publicKey)).rejects.toThrow();
    const other = await testSigningKey();
    await expect(verifyIntentJws(jws, other.publicKey)).rejects.toThrow();
  });

  it("loads the key written by keys:gen (kid = RFC 7638 thumbprint)", async () => {
    const key = await testSigningKey();
    expect(key.publicJwk).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", kid: key.kid });
    expect(key.publicJwk).not.toHaveProperty("d");
    await expect(loadSigningKey("{}")).rejects.toThrow(/Ed25519/);
  });
});

describe("mandate", () => {
  it("is AP2-inspired and mirrors the spec", () => {
    const m = buildMandate(demoSpec, { intentId: "int_1", specHash: "h", issuedAt: new Date(0) });
    expect(IntentMandate.parse(m)).toEqual(m);
    expect(m).toMatchObject({
      amountRange: { max: { currency: "USD", value: "40.00" } },
      recurrence: "none",
      allowedPayees: "any-verified",
      allowedConditions: ["new"],
      allowAddOns: false,
    });
    expect(describeSpec(demoSpec)).toMatch(/at most \$40\.00 all-in/);
  });
});
