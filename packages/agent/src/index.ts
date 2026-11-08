import type { AgentStep, AgentTrace } from "@poi/shared";

// Skeleton for the shopping agent (task F3, owned by the teammate).
// Signature is frozen in docs/CONTRACTS.md section 5.

export interface RunShopperOptions {
  userText: string;
  /** "provider:model", e.g. "openai:gpt-4o-mini" */
  model: string;
  bazaarUrl: string;
  scenario?: string;
  /** default 0.2 */
  temperature?: number;
  /** default 12 */
  maxSteps?: number;
  onStep?: (s: AgentStep) => void;
}

export interface RunShopperResult {
  trace: AgentTrace;
  checkout?: { orderId: string; merchantId: string; approveUrl: string };
}

export async function runShopper(opts: RunShopperOptions): Promise<RunShopperResult> {
  return {
    trace: {
      model: opts.model,
      userText: opts.userText,
      steps: [],
      observedListings: [],
      chosenSkus: [],
    },
  };
}
