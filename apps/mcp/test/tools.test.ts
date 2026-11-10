import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, expect, it } from "vitest";
import { voidOrder } from "@poi/shared/fixtures";
import { createMockApp } from "../../../packages/shared/mocks/app";

const connect = async (apiUrl: string) => {
  const client = new Client({ name: "poi-test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"],
      env: { ...(process.env as Record<string, string>), POI_API_URL: apiUrl },
      stderr: "ignore",
    }),
  );
  return client;
};
const textOf = (res: Awaited<ReturnType<Client["callTool"]>>) =>
  (res.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");

const closers: Array<() => Promise<unknown>> = [];
afterAll(() => Promise.all(closers.map((c) => c())));

it("exposes the POI tools over stdio and reports API errors as tool errors", async () => {
  const client = await connect("http://127.0.0.1:9");
  closers.push(() => client.close());
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([
    "arena_status",
    "attach_order",
    "capture_if_verified",
    "compile_intent",
    "explain_verdict",
    "get_verdict",
    "sign_intent",
    "verify_order",
  ]);
  expect(tools.find((t) => t.name === "verify_order")?.description).toMatch(
    /ALWAYS call this before paying/,
  );
  expect(tools.find((t) => t.name === "capture_if_verified")?.description).toMatch(
    /conformal gate/,
  );
  // nothing listens on :9, so the call fails -- as an MCP tool error, not a crash
  const res = await client.callTool({ name: "get_verdict", arguments: { verificationId: "x" } });
  expect(res.isError).toBe(true);
}, 30_000);

it("explain_verdict and arena_status read Layer 2 from the API (mock API)", async () => {
  const { httpServer: server, io } = createMockApp({ checkIntervalMs: 1, arenaIntervalMs: 1 });
  await new Promise<void>((r) => server.listen(0, r));
  closers.push(() => new Promise((r) => void io.close(() => r(undefined))));
  const client = await connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  closers.push(() => client.close());

  // the seeded mock order is a hidden subscription; verify it so it has a verdict
  await client.callTool({ name: "verify_order", arguments: { orderId: voidOrder.orderId } });
  const why = textOf(
    await client.callTool({ name: "explain_verdict", arguments: { orderId: voidOrder.orderId } }),
  );
  expect(why).toMatch(/verdict: VOID/);
  expect(why).toMatch(/layer 2:/);
  expect(why).toMatch(/matches a learned \w+ trick/);
  expect(why).toMatch(/conformal gate: alpha/);
  expect(why).toMatch(/over 12 months/);

  const arena = textOf(await client.callTool({ name: "arena_status", arguments: {} }));
  expect(arena).toMatch(/arena run \S+: /);
  expect(arena).toMatch(/gen 0: attacks that fooled POI-static \d+%, POI-immune \d+%/);
}, 60_000);
