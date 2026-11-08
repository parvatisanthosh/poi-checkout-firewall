// Read-only bridge to @paypal/agent-toolkit.
//
// The toolkit exposes PayPal operations as AI SDK tools. It has no authorize, capture or void
// tools (and its capture-style tools have no spend bound or human gate -- the gap POI exists to
// close), so every money action goes through our own REST client in orders.ts/payments.ts.
// We route reads the toolkit offers through it:
//   - get_order          -> getOrder (alternate read; the verifier's primary re-read stays on
//                           REST for typed errors, retries and our token cache)
//   - list_transactions  -> listTransactions
//   - list_disputes      -> listDisputes
// Not exposed by the toolkit, so REST only: get authorization, authorize, capture, void.
//
// The package pulls in ai@4, zod@3 and langchain, so it is imported lazily on first use and the
// API boots without loading it. Only the three read actions are enabled.
import { z } from "zod";
import { invalidResponse } from "./errors";
import { PayPalOrder } from "./schemas";

export interface ToolkitReaderOptions {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

interface ExecutableTool {
  execute?: (
    args: unknown,
    options: { toolCallId: string; messages: unknown[] },
  ) => PromiseLike<unknown>;
}

export const READ_ONLY_ACTIONS = {
  orders: { get: true },
  transactions: { list: true },
  disputes: { list: true },
} as const;

const TransactionList = z.looseObject({
  transaction_details: z.array(z.looseObject({})).optional(),
  total_items: z.number().optional(),
  total_pages: z.number().optional(),
});

const DisputeList = z.looseObject({
  items: z.array(z.looseObject({ dispute_id: z.string().optional() })).optional(),
});

export function createToolkitReader(opts: ToolkitReaderOptions) {
  let tools: Promise<Record<string, ExecutableTool>> | undefined;

  async function load(): Promise<Record<string, ExecutableTool>> {
    const { PayPalAgentToolkit } = await import("@paypal/agent-toolkit/ai-sdk");
    const toolkit = new PayPalAgentToolkit({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      configuration: {
        actions: READ_ONLY_ACTIONS,
        context: { sandbox: opts.baseUrl.includes("sandbox") },
      },
    });
    return toolkit.getTools() as unknown as Record<string, ExecutableTool>;
  }

  async function run(name: string, args: Record<string, unknown>): Promise<unknown> {
    tools ??= load();
    const tool = (await tools)[name];
    if (!tool?.execute) throw new Error(`@paypal/agent-toolkit has no "${name}" tool enabled`);
    // Direct execute skips the AI SDK's argument parsing, so callers pass every field.
    return tool.execute(args, { toolCallId: `poi-${name}`, messages: [] });
  }

  function parse<T>(schema: z.ZodType<T>, json: unknown, what: string): T {
    const r = schema.safeParse(json);
    if (!r.success) throw invalidResponse(what, r.error);
    return r.data;
  }

  return {
    /** Tool names currently enabled (for tests and /api/health diagnostics). */
    async toolNames(): Promise<string[]> {
      tools ??= load();
      return Object.keys(await tools);
    },
    async getOrder(orderId: string): Promise<PayPalOrder> {
      return parse(
        PayPalOrder,
        await run("get_order", { id: orderId }),
        `toolkit get_order ${orderId}`,
      );
    },
    async listTransactions(range: { startDate: Date; endDate: Date; transactionId?: string }) {
      const json = await run("list_transactions", {
        transaction_id: range.transactionId ?? null,
        transaction_status: "S",
        start_date: range.startDate.toISOString(),
        end_date: range.endDate.toISOString(),
      });
      return parse(TransactionList, json, "toolkit list_transactions");
    },
    async listDisputes(page = 1, pageSize = 10) {
      const json = await run("list_disputes", {
        disputed_transaction_id: null,
        page,
        page_size: pageSize,
      });
      return parse(DisputeList, json, "toolkit list_disputes");
    },
  };
}

export type ToolkitReader = ReturnType<typeof createToolkitReader>;
