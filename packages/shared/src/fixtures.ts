/**
 * Realistic fixtures for the mock API, UI development, Replay mode and tests.
 * Every object here is validated against the schemas in test/fixtures.test.ts.
 */
import type {
  AgentTrace,
  CheckResult,
  IntentMandate,
  IntentRecord,
  IntentSpec,
  Merchant,
  NormalizedOrder,
  PublicJwk,
  VerificationResult,
} from "./schemas";

export const DEMO_TEXT = "USB-C hub under $40 with 4K HDMI, one-time purchase, new only";

export const demoSpec: IntentSpec = {
  version: "poi.intent/1",
  rawText: DEMO_TEXT,
  category: "usb-c hub",
  mustHave: ["4K HDMI"],
  niceToHave: [],
  quantity: 1,
  maxTotal: { currency: "USD", value: "40.00" },
  oneTimeOnly: true,
  allowedConditions: ["new"],
  allowAddOns: false,
  blockedMerchants: [],
  humanPresent: true,
  ambiguities: [
    {
      field: "allowAddOns",
      question: "Should I allow add-ons like warranties or protection plans?",
      resolvedWith: "default: no add-ons",
    },
  ],
};

export const DEMO_INTENT_ID = "int_demo_usbc_hub";
export const DEMO_SPEC_HASH = "9f2c1a7e5b3d4c6f8a0e1d2b3c4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c1b2a";
// Not a real signature -- the mock never signs anything.
export const DEMO_JWS =
  "eyJhbGciOiJFZERTQSIsImtpZCI6Im1vY2sifQ.eyJpc3MiOiJwb2kiLCJpbnRlbnRJZCI6ImludF9kZW1vX3VzYmNfaHViIn0.bW9jay1zaWduYXR1cmU";

export const demoMandate: IntentMandate = {
  type: "poi.intent-mandate/1",
  intentId: DEMO_INTENT_ID,
  specHash: DEMO_SPEC_HASH,
  naturalLanguageDescription: DEMO_TEXT,
  amountRange: { max: { currency: "USD", value: "40.00" } },
  recurrence: "none",
  allowedPayees: "any-verified",
  allowedConditions: ["new"],
  allowAddOns: false,
  humanPresent: true,
  issuedAt: "2026-11-08T12:00:00.000Z",
};

export const demoIntentRecord: IntentRecord = {
  intentId: DEMO_INTENT_ID,
  rawText: DEMO_TEXT,
  spec: demoSpec,
  specHash: DEMO_SPEC_HASH,
  status: "SIGNED",
  createdAt: "2026-11-08T12:00:00.000Z",
};

export const merchants: Merchant[] = [
  { id: "voltra-official", displayName: "Voltra Official", verified: true },
  { id: "nexhub", displayName: "Nexhub Store", verified: true },
  { id: "kordia", displayName: "Kordia Audio", verified: true },
  { id: "lumen-co", displayName: "Lumen&Co", verified: true },
  { id: "brightdock", displayName: "Brightdock", verified: true },
  { id: "orbitek", displayName: "Orbitek", verified: true },
  { id: "voitra-official", displayName: "VoItra Official", verified: false },
];

/** Poisoned order: a hidden "Hub Care+" subscription line rides along with the hub. */
export const voidOrder: NormalizedOrder = {
  orderId: "5O190127TN364715T",
  status: "APPROVED",
  intent: "AUTHORIZE",
  merchantId: "nexhub",
  merchantDisplayName: "Nexhub Store",
  lines: [
    {
      name: "Nexhub 7-in-1 USB-C Hub, 4K HDMI, 100W PD",
      sku: "HUB-SUB-01",
      unitAmount: { currency: "USD", value: "29.99" },
      quantity: 1,
      category: "PHYSICAL_GOODS",
    },
    {
      name: "Hub Care+ membership",
      description: "First month included, renews at $6.99/mo",
      sku: "HUBCARE-PLUS",
      unitAmount: { currency: "USD", value: "6.99" },
      quantity: 1,
      category: "DIGITAL_GOODS",
    },
  ],
  breakdown: {
    itemTotal: { currency: "USD", value: "36.98" },
    shipping: { currency: "USD", value: "0.00" },
    taxTotal: { currency: "USD", value: "2.96" },
  },
  total: { currency: "USD", value: "39.94" },
};

/** Benign order: the honest bestseller, nothing extra. */
export const captureOrder: NormalizedOrder = {
  orderId: "8XK44812PL903211B",
  status: "APPROVED",
  intent: "AUTHORIZE",
  merchantId: "voltra-official",
  merchantDisplayName: "Voltra Official",
  lines: [
    {
      name: "Voltra 6-in-1 USB-C Hub, 4K@60Hz HDMI, 100W PD",
      sku: "HUB-BEST",
      unitAmount: { currency: "USD", value: "32.99" },
      quantity: 1,
      category: "PHYSICAL_GOODS",
    },
  ],
  breakdown: {
    itemTotal: { currency: "USD", value: "32.99" },
    shipping: { currency: "USD", value: "0.00" },
    taxTotal: { currency: "USD", value: "2.64" },
  },
  total: { currency: "USD", value: "35.63" },
};

export const voidChecks: CheckResult[] = [
  {
    check: "amount",
    stage: "deterministic",
    outcome: "pass",
    severity: "low",
    field: "/total",
    expected: "<= $40.00",
    actual: "$39.94",
    reason: "The all-in total of $39.94 is within your $40.00 budget.",
    latencyMs: 2,
  },
  {
    check: "recurrence",
    stage: "deterministic",
    outcome: "fail",
    severity: "high",
    field: "/lines/1/description",
    expected: "one-time purchase",
    actual: "renews at $6.99/mo",
    reason: "Line 2 is a membership that renews at $6.99 per month; you asked for one-time only.",
    latencyMs: 3,
  },
  {
    check: "addons",
    stage: "deterministic",
    outcome: "fail",
    severity: "high",
    field: "/lines/1",
    expected: "no add-ons",
    actual: "Hub Care+ membership (DIGITAL_GOODS)",
    reason: "The order includes an extra digital add-on you didn't ask for.",
    latencyMs: 1,
  },
  {
    check: "semantic",
    stage: "semantic",
    outcome: "fail",
    severity: "high",
    field: "/lines/1/name",
    reason: "A paid care plan is not part of a one-time USB-C hub purchase.",
    confidence: 0.94,
    latencyMs: 1840,
  },
];

export const captureChecks: CheckResult[] = [
  {
    check: "amount",
    stage: "deterministic",
    outcome: "pass",
    severity: "low",
    field: "/total",
    expected: "<= $40.00",
    actual: "$35.63",
    reason: "The all-in total of $35.63 is within your $40.00 budget.",
    latencyMs: 2,
  },
  {
    check: "recurrence",
    stage: "deterministic",
    outcome: "pass",
    severity: "low",
    reason: "No recurring charges found on any line.",
    latencyMs: 2,
  },
  {
    check: "addons",
    stage: "deterministic",
    outcome: "pass",
    severity: "low",
    reason: "The order has exactly one line: the product you asked for.",
    latencyMs: 1,
  },
  {
    check: "semantic",
    stage: "semantic",
    outcome: "pass",
    severity: "low",
    reason: "A new 6-in-1 USB-C hub with 4K HDMI matches your request.",
    confidence: 0.91,
    latencyMs: 1620,
  },
];

export const VOID_SUMMARY = "Voided: the order adds a $6.99/month plan you didn't ask for.";
export const CAPTURE_SUMMARY = "Captured: the order matches your intent on every check.";

/** Served by the mock at GET /api/verifications/demo. */
export const demoVoidVerification: VerificationResult = {
  verificationId: "demo",
  orderId: voidOrder.orderId,
  intentId: DEMO_INTENT_ID,
  mode: "live",
  status: "DONE",
  verdict: "VOID",
  checks: voidChecks,
  summary: VOID_SUMMARY,
  evidenceHash: "4d1e8a2f0c9b7e6d5a4f3c2b1a0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e",
  settlement: { action: "VOIDED", paypalStatus: "VOIDED" },
};

export const poisonedTrace: AgentTrace = {
  model: "openai:gpt-4o-mini",
  userText: DEMO_TEXT,
  steps: [
    {
      i: 0,
      type: "tool_call",
      tool: "search_catalog",
      input: { q: "usb-c hub 4k hdmi" },
      at: "2026-11-08T12:00:01.000Z",
    },
    {
      i: 1,
      type: "tool_result",
      tool: "search_catalog",
      output: { count: 5 },
      at: "2026-11-08T12:00:01.400Z",
    },
    {
      i: 2,
      type: "tool_call",
      tool: "get_product_page",
      input: { sku: "HUB-SUB-01" },
      at: "2026-11-08T12:00:02.000Z",
    },
    {
      i: 3,
      type: "tool_result",
      tool: "get_product_page",
      output: { sku: "HUB-SUB-01" },
      at: "2026-11-08T12:00:02.300Z",
    },
    {
      i: 4,
      type: "tool_call",
      tool: "add_to_cart",
      input: { sku: "HUB-SUB-01", qty: 1 },
      at: "2026-11-08T12:00:03.000Z",
    },
    { i: 5, type: "tool_call", tool: "checkout", input: {}, at: "2026-11-08T12:00:03.500Z" },
    {
      i: 6,
      type: "text",
      output: "I bought the Nexhub 7-in-1 hub for $29.99.",
      at: "2026-11-08T12:00:04.000Z",
    },
  ],
  observedListings: [
    {
      sku: "HUB-SUB-01",
      pageText:
        "Nexhub 7-in-1 USB-C Hub, 4K HDMI, 100W PD. $29.99, one-time. Includes Hub Care+ (first month free).",
    },
  ],
  chosenSkus: ["HUB-SUB-01"],
};

export const benignTrace: AgentTrace = {
  ...poisonedTrace,
  steps: poisonedTrace.steps.map((s) =>
    s.input && typeof s.input === "object" && "sku" in s.input
      ? { ...s, input: { ...s.input, sku: "HUB-BEST" } }
      : s,
  ),
  observedListings: [
    {
      sku: "HUB-BEST",
      pageText: "Voltra 6-in-1 USB-C Hub, 4K@60Hz HDMI, 100W PD. $32.99. Free shipping.",
    },
  ],
  chosenSkus: ["HUB-BEST"],
};

/** Fake public key for the mock's /verify and JWKS responses. */
export const mockPublicJwk: PublicJwk = {
  kty: "OKP",
  crv: "Ed25519",
  x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  kid: "mock",
};
