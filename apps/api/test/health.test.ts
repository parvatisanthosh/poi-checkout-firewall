import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPoiClient } from "@poi/shared";
import { createApp } from "../src/app";

const server = createServer(createApp());
let baseUrl = "";

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

it("GET /api/health matches the contract", async () => {
  const health = await createPoiClient({ baseUrl }).health();
  expect(health.ok).toBe(true);
});
