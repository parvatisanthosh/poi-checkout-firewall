import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, expect, it } from "vitest";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/index.ts"],
  env: { ...(process.env as Record<string, string>), POI_API_URL: "http://127.0.0.1:9" },
  stderr: "ignore",
});
const client = new Client({ name: "poi-test", version: "0" });
afterAll(() => client.close());

it("exposes the POI tools over stdio and reports API errors as tool errors", async () => {
  await client.connect(transport);
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([
    "attach_order",
    "capture_if_verified",
    "compile_intent",
    "get_verdict",
    "sign_intent",
    "verify_order",
  ]);
  expect(tools.find((t) => t.name === "verify_order")?.description).toMatch(
    /ALWAYS call this before paying/,
  );
  // nothing listens on :9, so the call fails -- as an MCP tool error, not a crash
  const res = await client.callTool({ name: "get_verdict", arguments: { verificationId: "x" } });
  expect(res.isError).toBe(true);
}, 30_000);
