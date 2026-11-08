import type { AgentTrace } from "@poi/shared";

export { createPoiClient, type PoiClient } from "@poi/shared";

/** A minimal agent trace that "chose" `sku` after reading two listings. */
export function demoTraceFor(sku: string): AgentTrace {
  return {
    model: "openai:gpt-4o-mini",
    userText: "USB-C hub under $40 with 4K HDMI, one-time, new only",
    steps: [],
    observedListings: [
      { sku, pageText: `Listing ${sku}: USB-C hub with 4K HDMI.` },
      { sku: "HUB-OTHER", pageText: "Another USB-C hub." },
    ],
    chosenSkus: [sku],
  };
}
