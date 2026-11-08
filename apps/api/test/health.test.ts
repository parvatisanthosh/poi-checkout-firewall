import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPoiClient, PoiApiError } from "@poi/shared";
import { buildDeps, createApp, type AppDeps } from "../src/app";
import { checkHealth } from "../src/lib/health";
import type { PrismaClient } from "../src/lib/prisma";

const merchants = [
  { id: "voltra-official", displayName: "Voltra Official", verified: true },
  { id: "voitra-official", displayName: "VoItra Official", verified: false },
];
const fakePrisma = {
  merchant: { findMany: async () => merchants },
} as unknown as PrismaClient;

const deps: Partial<AppDeps> = {
  prisma: () => fakePrisma,
  health: { db: async () => 1, redis: async () => "PONG", paypal: async () => "tok" },
};

const server = createServer(createApp(buildDeps(deps)));
let baseUrl = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("app", () => {
  it("GET /api/health reports every dependency", async () => {
    expect(await createPoiClient({ baseUrl }).health()).toEqual({
      ok: true,
      db: true,
      redis: true,
      paypal: true,
    });
  });

  it("GET /api/merchants matches the contract", async () => {
    expect(await createPoiClient({ baseUrl }).getMerchants()).toEqual(merchants);
  });

  it("sets security headers and echoes a request id", async () => {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { "X-Request-Id": "abc-123" } });
    expect(res.headers.get("x-request-id")).toBe("abc-123");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-powered-by")).toBeNull();
    const bad = await fetch(`${baseUrl}/api/health`, { headers: { "X-Request-Id": "<script>" } });
    expect(bad.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("answers unknown routes and bad JSON with the error contract", async () => {
    const poi = createPoiClient({ baseUrl });
    const missing = await fetch(`${baseUrl}/api/no-such-route`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    await expect(poi.getIntent("")).rejects.toBeInstanceOf(PoiApiError);
    const res = await fetch(`${baseUrl}/api/intents/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "INVALID_JSON", message: expect.any(String) },
    });
  });
});

describe("checkHealth", () => {
  it("is false per dependency on failure, timeout or missing config", async () => {
    const h = await checkHealth(
      {
        db: async () => {
          throw new Error("down");
        },
        redis: () => new Promise(() => {}), // hangs
      },
      50,
    );
    expect(h).toEqual({ ok: false, db: false, redis: false, paypal: false });
  });
});
