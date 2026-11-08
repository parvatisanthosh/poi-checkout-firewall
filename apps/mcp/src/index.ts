// P11: ProofOfIntent as an MCP server (stdio). A thin client of the POI API, so any MCP-capable
// agent can verify a PayPal order against the user's signed intent BEFORE money moves.
// stdout is the MCP channel: log to stderr only.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  AgentTrace,
  createPoiClient,
  IntentSpec,
  PoiApiError,
  type VerificationResult,
} from "@poi/shared";

const poi = createPoiClient({ baseUrl: process.env.POI_API_URL ?? "http://localhost:4000" });

const server = new McpServer({ name: "proof-of-intent", version: "0.1.0" });

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});
const fail = (err: unknown) => ({
  isError: true,
  ...text(
    err instanceof PoiApiError
      ? `POI error ${err.status} ${err.code}: ${err.message}`
      : `Error: ${(err as Error).message}`,
  ),
});
const tool =
  <A>(fn: (args: A) => Promise<ReturnType<typeof text>>) =>
  async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err);
    }
  };

function explain(v: VerificationResult) {
  const problems = v.checks
    .filter((c) => c.outcome !== "pass")
    .map((c) => `- [${c.outcome}/${c.severity}] ${c.check}: ${c.reason}`);
  return [
    `verdict: ${v.verdict ?? "(pending)"}  status: ${v.status}  settlement: ${v.settlement?.action ?? "NONE"}`,
    v.summary ?? "",
    problems.length ? `problems:\n${problems.join("\n")}` : "no problems found",
  ]
    .filter(Boolean)
    .join("\n");
}

server.registerTool(
  "compile_intent",
  {
    title: "Compile the user's intent",
    description:
      "Turn the user's shopping request (their own words) into a strict draft IntentSpec. Returns the draft plus ambiguity questions; ask the user any unresolved ones, then call sign_intent with the confirmed spec.",
    inputSchema: { text: z.string().min(1).max(2000).describe("The user's request, verbatim") },
  },
  tool(async ({ text: t }: { text: string }) => text(await poi.compileIntent(t))),
);

server.registerTool(
  "sign_intent",
  {
    title: "Sign the confirmed intent",
    description:
      "Sign the IntentSpec the USER confirmed (never one you edited on your own). Returns an intentId to attach to the order. Budgets are all-in (items + shipping + tax + fees).",
    inputSchema: { spec: IntentSpec.describe("The confirmed IntentSpec from compile_intent") },
  },
  tool(async ({ spec }: { spec: IntentSpec }) => text(await poi.signIntent(spec))),
);

server.registerTool(
  "attach_order",
  {
    title: "Attach a PayPal order to an intent",
    description:
      "After creating a PayPal order (intent AUTHORIZE) for the user, attach it to their signed intent so POI can verify it. Pass your agent trace if you have one (it powers the injection checks).",
    inputSchema: {
      orderId: z.string().describe("PayPal order id"),
      intentId: z.string().describe("From sign_intent"),
      agentTrace: AgentTrace.optional().describe(
        "What you read and chose (model, observedListings, chosenSkus)",
      ),
      mode: z.enum(["live", "dry-run"]).default("dry-run"),
    },
  },
  tool(
    async (a: {
      orderId: string;
      intentId: string;
      agentTrace?: AgentTrace;
      mode: "live" | "dry-run";
    }) => {
      const agentTrace = a.agentTrace ?? {
        model: "unknown:unknown",
        userText: "",
        steps: [],
        observedListings: [],
        chosenSkus: [],
      };
      return text(
        await poi.attachOrder(a.orderId, { intentId: a.intentId, agentTrace, mode: a.mode }),
      );
    },
  ),
);

server.registerTool(
  "verify_order",
  {
    title: "Verify an order (dry run)",
    description:
      "ALWAYS call this before paying. Re-reads the order from PayPal and checks it against the user's signed intent (budget all-in, recurring charges, condition, add-ons, look-alike sellers, injected pages). Moves no money. Waits for and returns the verdict: CAPTURE (ok), ASK_HUMAN, or VOID.",
    inputSchema: {
      orderId: z.string().describe("A PayPal order already attached with attach_order"),
    },
  },
  tool(async ({ orderId }: { orderId: string }) => {
    const { verificationId } = await poi.verifyOrder(orderId);
    const v = await poi.waitForVerification(verificationId, { timeoutMs: 60_000 });
    return text(`verificationId: ${verificationId}\n${explain(v)}`);
  }),
);

server.registerTool(
  "get_verdict",
  {
    title: "Get a verification's verdict",
    description: "Fetch the current state and verdict of a verification by id.",
    inputSchema: { verificationId: z.string() },
  },
  tool(async ({ verificationId }: { verificationId: string }) =>
    text(explain(await poi.getVerification(verificationId))),
  ),
);

server.registerTool(
  "capture_if_verified",
  {
    title: "Pay, only if POI approves",
    description:
      "Authorize the approved PayPal order and let POI verify it live. Money is captured ONLY if the verdict is CAPTURE; on VOID the hold is released for free; on ASK_HUMAN nothing moves until the user decides. Returns the outcome and reasons. The order must be attached in live mode and approved by the buyer.",
    inputSchema: { orderId: z.string() },
  },
  tool(async ({ orderId }: { orderId: string }) => {
    const { verificationId } = await poi.authorizeOrder(orderId);
    const v = await poi.waitForVerification(verificationId, { timeoutMs: 90_000 });
    const outcome =
      v.settlement?.action === "CAPTURED"
        ? "Paid: POI verified the order and captured the payment."
        : v.settlement?.action === "VOIDED"
          ? "Not paid: POI voided the authorization (no charge)."
          : v.settlement?.action === "PENDING_HUMAN"
            ? "Not paid yet: the user must approve or reject this order in POI."
            : "No settlement happened.";
    return text(`${outcome}\nverificationId: ${verificationId}\n${explain(v)}`);
  }),
);

await server.connect(new StdioServerTransport());
console.error(`[poi-mcp] ready, POI API at ${process.env.POI_API_URL ?? "http://localhost:4000"}`);
