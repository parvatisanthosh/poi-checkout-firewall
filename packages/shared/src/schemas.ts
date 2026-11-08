/**
 * POI shared contracts -- the single source of truth (docs/CONTRACTS.md section 2-3).
 * Changing anything here changes the contract: tell your teammate first, own small PR.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const Money = z.object({
  currency: z.string().length(3), // demo uses "USD" only
  value: z.string().regex(/^\d+(\.\d{1,2})?$/), // PayPal sends strings
});
export type Money = z.infer<typeof Money>;

export const Condition = z.enum(["new", "renewed", "used"]);
export type Condition = z.infer<typeof Condition>;

export const RunMode = z.enum(["live", "dry-run"]);
export type RunMode = z.infer<typeof RunMode>;

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

export const Ambiguity = z.object({
  field: z.string(),
  question: z.string(),
  resolvedWith: z.string().optional(),
});
export type Ambiguity = z.infer<typeof Ambiguity>;

/** What the user meant. Produced by the intent compiler, confirmed + signed by the user. */
export const IntentSpec = z.object({
  version: z.literal("poi.intent/1"),
  rawText: z.string(),
  category: z.string(), // "usb-c hub"
  mustHave: z.array(z.string()).default([]), // ["4K HDMI", "100W PD"]
  niceToHave: z.array(z.string()).default([]),
  quantity: z.number().int().positive().default(1),
  maxTotal: Money, // ALL-IN: items + shipping + tax + fees
  oneTimeOnly: z.boolean().default(true), // no recurring charges of any kind
  allowedConditions: z.array(Condition).default(["new"]),
  allowAddOns: z.boolean().default(false), // warranties, protection plans, bundles
  allowedMerchants: z.array(z.string()).optional(), // merchant ids; omitted = any verified merchant
  blockedMerchants: z.array(z.string()).default([]),
  humanPresent: z.boolean().default(true),
  ambiguities: z.array(Ambiguity).default([]),
});
/** Parsed spec (defaults applied). */
export type IntentSpec = z.infer<typeof IntentSpec>;
/** Spec as a client may send it (defaulted fields optional). */
export type IntentSpecInput = z.input<typeof IntentSpec>;

/**
 * AP2-inspired intent mandate. NOT AP2-compliant -- it borrows the idea of a
 * user-signed, machine-checkable statement of what an agent may buy.
 */
export const IntentMandate = z.object({
  type: z.literal("poi.intent-mandate/1"),
  intentId: z.string(),
  specHash: z.string(),
  naturalLanguageDescription: z.string(),
  amountRange: z.object({ max: Money }),
  recurrence: z.enum(["none", "allowed"]),
  allowedPayees: z.union([z.array(z.string()), z.literal("any-verified")]),
  allowedConditions: z.array(Condition),
  allowAddOns: z.boolean(),
  humanPresent: z.boolean(),
  issuedAt: z.string(),
});
export type IntentMandate = z.infer<typeof IntentMandate>;

export const IntentStatus = z.enum(["SIGNED", "REVOKED"]);
export type IntentStatus = z.infer<typeof IntentStatus>;

export const IntentRecord = z.object({
  intentId: z.string(),
  rawText: z.string(),
  spec: IntentSpec,
  specHash: z.string(),
  status: IntentStatus,
  createdAt: z.string(),
});
export type IntentRecord = z.infer<typeof IntentRecord>;

// ---------------------------------------------------------------------------
// Order (re-read from PayPal and flattened). Every merchant-written string is untrusted.
// ---------------------------------------------------------------------------

export const NormalizedLine = z.object({
  name: z.string(),
  description: z.string().optional(),
  sku: z.string().optional(),
  unitAmount: Money,
  quantity: z.number().int(),
  category: z.enum(["PHYSICAL_GOODS", "DIGITAL_GOODS", "DONATION"]).optional(),
});
export type NormalizedLine = z.infer<typeof NormalizedLine>;

export const NormalizedOrder = z.object({
  orderId: z.string(),
  status: z.string(), // CREATED | APPROVED | COMPLETED ...
  intent: z.enum(["CAPTURE", "AUTHORIZE"]),
  merchantId: z.string(), // from purchase_units[0].custom_id "bazaar:<id>"
  merchantDisplayName: z.string(), // from purchase_units[0].description (fallback soft_descriptor)
  lines: z.array(NormalizedLine),
  breakdown: z.object({
    itemTotal: Money,
    shipping: Money.optional(),
    handling: Money.optional(),
    taxTotal: Money.optional(),
    insurance: Money.optional(),
    discount: Money.optional(),
  }),
  total: Money,
});
export type NormalizedOrder = z.infer<typeof NormalizedOrder>;

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export const CheckId = z.enum([
  "amount",
  "currency",
  "quantity",
  "recurrence",
  "condition",
  "addons",
  "merchant",
  "lookalike",
  "category",
  "terms",
  "semantic",
  "shadow",
  "injection",
]);
export type CheckId = z.infer<typeof CheckId>;

export const Stage = z.enum(["deterministic", "semantic", "rag", "shadow"]);
export type Stage = z.infer<typeof Stage>;

export const CheckResult = z.object({
  check: CheckId,
  stage: Stage,
  outcome: z.enum(["pass", "warn", "fail"]),
  severity: z.enum(["low", "medium", "high"]),
  field: z.string().optional(), // JSON pointer into NormalizedOrder, e.g. "/lines/1/name"
  expected: z.string().optional(),
  actual: z.string().optional(),
  reason: z.string(), // one plain-English sentence for the UI
  confidence: z.number().min(0).max(1).optional(),
  latencyMs: z.number(),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const Verdict = z.enum(["CAPTURE", "ASK_HUMAN", "VOID"]);
export type Verdict = z.infer<typeof Verdict>;

/** Drives ablations in the benchmark. */
export const VerifierConfig = z.object({
  deterministic: z.boolean().default(true),
  semantic: z.boolean().default(true),
  terms: z.boolean().default(true),
  shadow: z.boolean().default(true),
});
export type VerifierConfig = z.infer<typeof VerifierConfig>;
export type VerifierConfigInput = z.input<typeof VerifierConfig>;

export const VerificationStatus = z.enum(["QUEUED", "RUNNING", "DONE", "ERROR"]);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

export const SettlementAction = z.enum(["CAPTURED", "VOIDED", "PENDING_HUMAN", "NONE"]);
export type SettlementAction = z.infer<typeof SettlementAction>;

export const VerificationResult = z.object({
  verificationId: z.string(),
  orderId: z.string(),
  intentId: z.string(),
  mode: RunMode,
  status: VerificationStatus,
  verdict: Verdict.optional(),
  checks: z.array(CheckResult),
  summary: z.string().optional(), // "Voided: the order adds a $6.99/month plan you didn't ask for."
  evidenceHash: z.string().optional(),
  settlement: z
    .object({
      action: SettlementAction,
      paypalStatus: z.string().optional(),
    })
    .optional(),
});
export type VerificationResult = z.infer<typeof VerificationResult>;

// ---------------------------------------------------------------------------
// Agent trace (produced by packages/agent, consumed by the shadow run and the ledger)
// ---------------------------------------------------------------------------

export const AgentStep = z.object({
  i: z.number().int(),
  type: z.enum(["text", "tool_call", "tool_result"]),
  tool: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  at: z.string(),
});
export type AgentStep = z.infer<typeof AgentStep>;

export const AgentTrace = z.object({
  model: z.string(), // "openai:gpt-4o-mini" -- provider:model, same id format everywhere
  userText: z.string(),
  steps: z.array(AgentStep),
  observedListings: z.array(z.object({ sku: z.string(), pageText: z.string() })), // what it read before choosing
  chosenSkus: z.array(z.string()),
});
export type AgentTrace = z.infer<typeof AgentTrace>;

// ---------------------------------------------------------------------------
// Registry, ledger, evidence
// ---------------------------------------------------------------------------

export const Merchant = z.object({
  id: z.string(), // "voltra-official"
  displayName: z.string(),
  verified: z.boolean(),
});
export type Merchant = z.infer<typeof Merchant>;

export const LedgerRow = z.object({
  orderId: z.string(),
  createdAt: z.string(),
  mode: RunMode,
  model: z.string().optional(),
  merchantDisplayName: z.string(),
  total: Money,
  verdict: Verdict.optional(), // absent while the verification is still running
  topReason: z.string().optional(),
  settlement: SettlementAction,
  runTag: z.string().optional(),
});
export type LedgerRow = z.infer<typeof LedgerRow>;

export const EvidenceView = z.object({
  seq: z.number().int(),
  prevHash: z.string(),
  hash: z.string(),
  payload: z.unknown(),
  jws: z.string(),
  createdAt: z.string(),
});
export type EvidenceView = z.infer<typeof EvidenceView>;

/** Public Ed25519 JWK (OKP). */
export const PublicJwk = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: z.string(),
    kid: z.string().optional(),
  })
  .passthrough();
export type PublicJwk = z.infer<typeof PublicJwk>;

// ---------------------------------------------------------------------------
// API request / response bodies (docs/CONTRACTS.md section 3)
// ---------------------------------------------------------------------------

export const ApiErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

export const CompileIntentRequest = z.object({ text: z.string().min(1).max(2000) });
export type CompileIntentRequest = z.infer<typeof CompileIntentRequest>;
export const CompileIntentResponse = z.object({
  draft: IntentSpec,
  ambiguities: z.array(Ambiguity),
});
export type CompileIntentResponse = z.infer<typeof CompileIntentResponse>;

export const SignIntentRequest = z.object({ spec: IntentSpec });
export type SignIntentRequest = z.input<typeof SignIntentRequest>;
export const SignIntentResponse = z.object({
  intentId: z.string(),
  mandate: IntentMandate,
  jws: z.string(),
});
export type SignIntentResponse = z.infer<typeof SignIntentResponse>;

export const GetIntentResponse = z.object({
  intent: IntentRecord,
  mandate: IntentMandate,
  jws: z.string(),
});
export type GetIntentResponse = z.infer<typeof GetIntentResponse>;

export const AttachOrderRequest = z.object({
  intentId: z.string(),
  agentTrace: AgentTrace,
  mode: RunMode,
  runTag: z.string().optional(),
});
export type AttachOrderRequest = z.infer<typeof AttachOrderRequest>;
export const OkResponse = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;

export const AuthorizeOrderResponse = z.object({
  authorizationId: z.string(),
  verificationId: z.string(),
});
export type AuthorizeOrderResponse = z.infer<typeof AuthorizeOrderResponse>;

export const VerifyOrderRequest = z.object({
  mode: z.literal("dry-run"),
  config: VerifierConfig.optional(),
});
export type VerifyOrderRequest = z.input<typeof VerifyOrderRequest>;
export const VerifyOrderResponse = z.object({ verificationId: z.string() });
export type VerifyOrderResponse = z.infer<typeof VerifyOrderResponse>;

export const DecisionRequest = z.object({ decision: z.enum(["CAPTURE", "VOID"]) });
export type DecisionRequest = z.infer<typeof DecisionRequest>;

export const LedgerQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  mode: RunMode.optional(),
});
export type LedgerQuery = z.input<typeof LedgerQuery>;
export const LedgerResponse = z.object({
  rows: z.array(LedgerRow),
  nextCursor: z.string().nullable(),
});
export type LedgerResponse = z.infer<typeof LedgerResponse>;

export const VerifyRecordResponse = z.object({
  intent: IntentRecord,
  order: NormalizedOrder.nullable(),
  verification: VerificationResult.nullable(),
  evidence: EvidenceView.nullable(),
  chainValid: z.boolean(),
  signatureValid: z.boolean(),
  publicJwk: PublicJwk,
});
export type VerifyRecordResponse = z.infer<typeof VerifyRecordResponse>;

export const MerchantsResponse = z.array(Merchant);
export type MerchantsResponse = z.infer<typeof MerchantsResponse>;

export const HealthResponse = z.object({
  ok: z.boolean(),
  db: z.boolean(),
  redis: z.boolean(),
  paypal: z.boolean(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
