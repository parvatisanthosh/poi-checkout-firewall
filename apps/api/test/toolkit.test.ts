import { expect, it } from "vitest";
import { createToolkitReader } from "../src/paypal/toolkit";

// Loads the real @paypal/agent-toolkit (no network: getTools() only builds tool objects).
it("enables only the read-only toolkit tools", async () => {
  const reader = createToolkitReader({
    clientId: "cid",
    clientSecret: "secret",
    baseUrl: "https://api-m.sandbox.paypal.com",
  });
  expect((await reader.toolNames()).sort()).toEqual([
    "get_order",
    "list_disputes",
    "list_transactions",
  ]);
}, 30_000);
