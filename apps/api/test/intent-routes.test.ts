import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPoiClient } from "@poi/shared";
import { merchants } from "@poi/shared/fixtures";
import { buildDeps, createApp } from "../src/app";
import type { SigningKey } from "../src/evidence/keys";
import type { PrismaClient } from "../src/lib/prisma";
import { hashSpec, verifyIntentJws } from "../src/intent/sign";
import { testSigningKey } from "./helpers";

// In-memory stand-in for the two Prisma calls the intent routes make.
const intents = new Map<string, Record<string, unknown>>();
const fakePrisma = {
  merchant: { findMany: async () => merchants },
  intent: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      intents.set(data.id as string, { status: "SIGNED", ...data });
      return data;
    },
    findUnique: async ({ where }: { where: { id: string } }) => intents.get(where.id) ?? null,
  },
} as unknown as PrismaClient;

let key: SigningKey;
let baseUrl = "";
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  key = await testSigningKey();
  server = createServer(
    createApp(
      buildDeps({
        prisma: () => fakePrisma,
        signingKey: async () => key,
        compilerModel: undefined,
      }),
    ),
  );
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("intent routes", () => {
  it("compile -> sign -> get", async () => {
    const poi = createPoiClient({ baseUrl });
    const { draft, ambiguities } = await poi.compileIntent(
      "USB-C hub under $40, one-time, new only",
    );
    expect(draft.maxTotal.value).toBe("40.00");
    expect(ambiguities.filter((a) => !a.resolvedWith)).toEqual([]);

    const signed = await poi.signIntent(draft);
    expect(signed.intentId).toMatch(/^int_/);
    expect(signed.mandate.specHash).toBe(hashSpec(draft));
    const payload = await verifyIntentJws(signed.jws, key.publicKey);
    expect(payload).toMatchObject({ intentId: signed.intentId, specHash: hashSpec(draft) });

    const got = await poi.getIntent(signed.intentId);
    expect(got.intent).toMatchObject({
      intentId: signed.intentId,
      status: "SIGNED",
      rawText: draft.rawText,
    });
    expect(got.jws).toBe(signed.jws);
    expect(got.mandate).toEqual(signed.mandate);
  });

  it("refuses to sign a spec without a budget", async () => {
    const poi = createPoiClient({ baseUrl });
    const { draft } = await poi.compileIntent("get me a decent hub");
    await expect(poi.signIntent(draft)).rejects.toMatchObject({
      status: 422,
      code: "INTENT_INCOMPLETE",
    });
  });

  it("404s an unknown intent and 400s a bad spec", async () => {
    const poi = createPoiClient({ baseUrl });
    await expect(poi.getIntent("int_nope")).rejects.toMatchObject({
      status: 404,
      code: "INTENT_NOT_FOUND",
    });
    const res = await fetch(`${baseUrl}/api/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        spec: { version: "poi.intent/1", maxTotal: { currency: "USD", value: 40 } },
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("serves the public key at /.well-known/jwks.json", async () => {
    const res = await fetch(`${baseUrl}/.well-known/jwks.json`);
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toEqual([key.publicJwk]);
    expect(body.keys[0]).not.toHaveProperty("d");
  });
});
