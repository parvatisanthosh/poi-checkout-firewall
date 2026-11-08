# ProofOfIntent -- Shared Contracts

Frozen on Day 0 (Sun 8 Nov 2026). **Contracts are law.** Neither teammate changes a shared type,
endpoint or socket event without telling the other. Changes go in `packages/shared` first, in their own
small PR, and this file is updated in the same PR.

The Zod schemas in [`packages/shared/src/schemas.ts`](../packages/shared/src/schemas.ts) (POI API) and
[`packages/shared/src/bazaar.ts`](../packages/shared/src/bazaar.ts) (Bazaar API) are the single source of
truth. Both the API and the web app import them, so a mismatch fails typecheck instead of failing the demo.
If this document and the code disagree, the code wins and this document gets fixed.

## 1. Ports and services

| Service                   | Folder                                   | Port       | Owner   |
| ------------------------- | ---------------------------------------- | ---------- | ------- |
| Web (Next.js)             | `apps/web`                               | 3000       | Friend  |
| POI API + Socket.IO       | `apps/api`                               | 4000       | Parvati |
| POI worker (BullMQ)       | `apps/api` (`worker.ts`)                 | none       | Parvati |
| Bazaar                    | `apps/bazaar`                            | 4100       | Friend  |
| MCP server                | `apps/mcp`                               | stdio      | Parvati |
| Mock POI API (Day 0-2)    | `packages/shared/mocks`                  | 4000       | Parvati |
| Postgres 16 + pgvector    | `docker-compose.yml`                     | 5432       | Parvati |
| Redis 7                   | `docker-compose.yml`                     | 6379       | Parvati |

Folder ownership: Parvati owns `apps/api`, `apps/mcp`, `packages/shared`, `prisma/`. Friend owns
`apps/web`, `apps/bazaar`, `packages/agent`, `bench/`, `postman/`. Editing the other person's folder means
asking first.

## 2. Core schemas (`packages/shared/src/schemas.ts`)

```ts
export const Money = z.object({
  currency: z.string().length(3),               // demo uses "USD" only
  value: z.string().regex(/^\d+(\.\d{1,2})?$/), // PayPal sends strings
});

export const Condition = z.enum(["new", "renewed", "used"]);

// What the user meant. Produced by the intent compiler, confirmed + signed by the user.
export const IntentSpec = z.object({
  version: z.literal("poi.intent/1"),
  rawText: z.string(),
  category: z.string(),                         // "usb-c hub"
  mustHave: z.array(z.string()).default([]),    // ["4K HDMI", "100W PD"]
  niceToHave: z.array(z.string()).default([]),
  quantity: z.number().int().positive().default(1),
  maxTotal: Money,                              // ALL-IN: items + shipping + tax + fees
  oneTimeOnly: z.boolean().default(true),       // no recurring charges of any kind
  allowedConditions: z.array(Condition).default(["new"]),
  allowAddOns: z.boolean().default(false),      // warranties, protection plans, bundles
  allowedMerchants: z.array(z.string()).optional(), // merchant ids; omitted = any verified merchant
  blockedMerchants: z.array(z.string()).default([]),
  humanPresent: z.boolean().default(true),
  ambiguities: z.array(Ambiguity).default([]),  // { field, question, resolvedWith? }
});

// The PayPal order, re-read from PayPal and flattened. Every merchant-written string is untrusted.
export const NormalizedLine = z.object({
  name: z.string(),
  description: z.string().optional(),
  sku: z.string().optional(),
  unitAmount: Money,
  quantity: z.number().int(),
  category: z.enum(["PHYSICAL_GOODS", "DIGITAL_GOODS", "DONATION"]).optional(),
});

export const NormalizedOrder = z.object({
  orderId: z.string(),
  status: z.string(),                           // CREATED | APPROVED | COMPLETED ...
  intent: z.enum(["CAPTURE", "AUTHORIZE"]),
  merchantId: z.string(),                       // from purchase_units[0].custom_id "bazaar:<id>"
  merchantDisplayName: z.string(),              // from purchase_units[0].soft_descriptor / description
  lines: z.array(NormalizedLine),
  breakdown: z.object({
    itemTotal: Money, shipping: Money.optional(), handling: Money.optional(),
    taxTotal: Money.optional(), insurance: Money.optional(), discount: Money.optional(),
  }),
  total: Money,
});

export const CheckId = z.enum([
  "amount", "currency", "quantity", "recurrence", "condition", "addons",
  "merchant", "lookalike", "category", "terms", "semantic", "shadow", "injection",
]);

export const CheckResult = z.object({
  check: CheckId,
  stage: z.enum(["deterministic", "semantic", "rag", "shadow"]),
  outcome: z.enum(["pass", "warn", "fail"]),
  severity: z.enum(["low", "medium", "high"]),
  field: z.string().optional(),                 // JSON pointer into NormalizedOrder, e.g. "/lines/1/name"
  expected: z.string().optional(),
  actual: z.string().optional(),
  reason: z.string(),                           // one plain-English sentence for the UI
  confidence: z.number().min(0).max(1).optional(),
  latencyMs: z.number(),
});

export const Verdict = z.enum(["CAPTURE", "ASK_HUMAN", "VOID"]);

export const VerifierConfig = z.object({        // drives ablations in the benchmark
  deterministic: z.boolean().default(true),
  semantic: z.boolean().default(true),
  terms: z.boolean().default(true),
  shadow: z.boolean().default(true),
});

export const VerificationResult = z.object({
  verificationId: z.string(),
  orderId: z.string(),
  intentId: z.string(),
  mode: z.enum(["live", "dry-run"]),
  status: z.enum(["QUEUED", "RUNNING", "DONE", "ERROR"]),
  verdict: Verdict.optional(),
  checks: z.array(CheckResult),
  summary: z.string().optional(),               // "Voided: the order adds a $6.99/month plan you didn't ask for."
  evidenceHash: z.string().optional(),
  settlement: z.object({
    action: z.enum(["CAPTURED", "VOIDED", "PENDING_HUMAN", "NONE"]),
    paypalStatus: z.string().optional(),
  }).optional(),
});

// What the agent did. Produced by packages/agent, consumed by the shadow run and the ledger.
export const AgentStep = z.object({
  i: z.number().int(),
  type: z.enum(["text", "tool_call", "tool_result"]),
  tool: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  at: z.string(),
});

export const AgentTrace = z.object({
  model: z.string(),                            // "openai:gpt-4o-mini" -- provider:model, same id format everywhere
  userText: z.string(),
  steps: z.array(AgentStep),
  observedListings: z.array(z.object({ sku: z.string(), pageText: z.string() })), // what it read before choosing
  chosenSkus: z.array(z.string()),
});
```

### 2.1 Additions made during the Day 0 freeze

The plan named these shapes without spelling them out. They are now defined in `schemas.ts`:

| Schema               | Shape                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `Ambiguity`          | `{ field, question, resolvedWith? }`                                                                   |
| `RunMode`            | `"live" \| "dry-run"`                                                                                  |
| `SettlementAction`   | `"CAPTURED" \| "VOIDED" \| "PENDING_HUMAN" \| "NONE"`                                                  |
| `IntentMandate`      | AP2-*inspired* (not AP2-compliant) mandate: `{ type: "poi.intent-mandate/1", intentId, specHash, naturalLanguageDescription, amountRange: { max }, recurrence: "none" \| "allowed", allowedPayees, allowedConditions, allowAddOns, humanPresent, issuedAt }` |
| `IntentRecord`       | `{ intentId, rawText, spec, specHash, status: "SIGNED" \| "REVOKED", createdAt }`                      |
| `Merchant`           | `{ id, displayName, verified }`                                                                        |
| `LedgerRow`          | `{ orderId, createdAt, mode, model?, merchantDisplayName, total, verdict?, topReason?, settlement, runTag? }` (`verdict` is absent while a verification is still running) |
| `EvidenceView`       | `{ seq, prevHash, hash, payload, jws, createdAt }`                                                     |
| `ApiErrorBody`       | `{ error: { code, message } }`                                                                         |

Request/response schemas for every endpoint below are exported with the names in the table
(`CompileIntentRequest`, `CompileIntentResponse`, ...).

### 2.2 Verdict lattice (`apps/api/src/verifier/lattice.ts`)

`CAPTURE < ASK_HUMAN < VOID`; the final verdict is the maximum over all checks.

- Any **deterministic** `fail` -> VOID.
- Any `fail` with severity `high` from any stage -> VOID.
- Any `fail` with severity `medium`, any `warn` with severity `high`, or a `shadow` signal on its own -> ASK_HUMAN.
- Everything else -> CAPTURE.
- **Rule:** LLM stages can only push the verdict up, never down. A semantic `pass` cannot rescue a
  deterministic `fail`. This is what stops an injected page from talking the judge into approving.

## 3. POI API (`apps/api`, prefix `/api`)

| Method | Path                              | Body                                                  | Returns                                                                 | Called by                     |
| ------ | --------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------- |
| POST   | `/intents/compile`                | `{ text }`                                            | `{ draft: IntentSpec, ambiguities: Ambiguity[] }`                       | web                           |
| POST   | `/intents`                        | `{ spec: IntentSpec }`                                | `{ intentId, mandate, jws }`                                            | web                           |
| GET    | `/intents/:id`                    | none                                                  | `{ intent: IntentRecord, mandate, jws }`                                | web, mcp                      |
| POST   | `/orders/:orderId/attach`         | `{ intentId, agentTrace, mode, runTag? }`             | `{ ok: true }`                                                          | web (after Bazaar checkout), bench |
| POST   | `/orders/:orderId/authorize`      | `{}`                                                  | `{ authorizationId, verificationId }`                                   | web, after PayPal approval    |
| POST   | `/orders/:orderId/verify`         | `{ mode: "dry-run", config?: VerifierConfig }`        | `{ verificationId }`                                                    | bench, mcp                    |
| GET    | `/verifications/:id`              | none                                                  | `VerificationResult`                                                    | web, bench (polling), mcp     |
| POST   | `/verifications/:id/decision`     | `{ decision: "CAPTURE" \| "VOID" }`                   | `VerificationResult`                                                    | web (ASK_HUMAN buttons)       |
| GET    | `/ledger`                         | `?limit&cursor&mode`                                  | `{ rows: LedgerRow[], nextCursor }` (`nextCursor` is `null` at the end) | web (AG Grid ledger)          |
| GET    | `/verify/:orderId`                | none                                                  | `{ intent, order, verification, evidence, chainValid, signatureValid, publicJwk }` | web, judges        |
| GET    | `/merchants`                      | none                                                  | `Merchant[]` (registry with verified flag)                              | web, bazaar seed check        |
| POST   | `/webhooks/paypal`                | PayPal event                                          | 200                                                                     | PayPal                        |
| GET    | `/health`                         | none                                                  | `{ ok, db, redis, paypal }`                                             | Render, README                |
| GET    | `/.well-known/jwks.json`          | none                                                  | `{ keys: [publicJwk] }`                                                 | judges                        |

Errors always return `{ error: { code, message } }` with a proper HTTP status.

A typed client for every endpoint is exported as `createPoiClient({ baseUrl })` from `@poi/shared`.

## 4. Bazaar API (`apps/bazaar`, port 4100)

Schemas in `packages/shared/src/bazaar.ts`.

| Method | Path                    | Body                               | Returns                                                                                       |
| ------ | ----------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| GET    | `/catalog`              | `?q&category&scenario`             | `ListingCard[]`: `{ sku, title, priceUsd, merchantId, merchantName, rating, badge?, snippet }` |
| GET    | `/products/:sku`        | none                               | `{ card, pageText, pageHtml, merchantId }`. `pageText` is exactly what the agent reads, hidden text included. |
| POST   | `/checkout`             | `{ items: [{ sku, qty }], scenario? }` | `{ orderId, approveUrl, merchantId, total }`. Creates the PayPal order with `intent: AUTHORIZE`. |
| GET    | `/merchants/:id/terms`  | none                               | merchant terms as Markdown                                                                    |
| GET    | `/scenarios/:id`        | none                               | the catalog subset for one benchmark scenario                                                 |
| GET    | `/health`               | none                               | `{ ok: true }`                                                                                |

**Order construction rule (important for POI):** every order sets
`purchase_units[0].custom_id = "bazaar:<merchantId>"` and `soft_descriptor` / `description` to the merchant
display name, and always sends a full `amount.breakdown` plus `items[]`. All Bazaar merchants share one
PayPal sandbox business account, so this is how POI tells merchants apart. The README says so under
"real vs simulated".

## 5. Agent package (`packages/agent`)

```ts
runShopper(opts: {
  userText: string;
  model: string;          // "openai:gpt-4o-mini" | "anthropic:claude-haiku-..." | "google:gemini-..." | "groq:llama-..."
  bazaarUrl: string;
  scenario?: string;
  temperature?: number;   // default 0.2
  maxSteps?: number;      // default 12
  onStep?: (s: AgentStep) => void;
}): Promise<{ trace: AgentTrace; checkout?: { orderId: string; merchantId: string; approveUrl: string } }>
```

POI's shadow run reuses `getModel(id)` from `@poi/shared/llm` so it can call the same model the agent used.

## 6. Socket.IO events (namespace `/live`, room `order:<orderId>`)

| Event            | Direction        | Payload                                                         |
| ---------------- | ---------------- | --------------------------------------------------------------- |
| `subscribe`      | client -> server | `{ orderId }`                                                   |
| `verify:started` | server -> client | `{ verificationId, orderId, stages: string[] }`                 |
| `verify:check`   | server -> client | `{ verificationId, orderId, check: CheckResult }` (one per check, as it finishes) |
| `verify:verdict` | server -> client | `{ verificationId, orderId, verdict, summary }`                 |
| `order:settled`  | server -> client | `{ orderId, action: "CAPTURED" \| "VOIDED", paypalStatus }`     |

Typed as `ServerToClientEvents` / `ClientToServerEvents` in `packages/shared/src/events.ts`; use them as
socket.io generics on both sides. Agent steps stream from the web app's own route (`/api/agent/run`,
Server-Sent Events), not through POI.

## 7. Prisma schema (`prisma/schema.prisma`)

Built in task P2. Models: `Intent`, `OrderRecord` (id = PayPal order id), `Verification`, `EvidenceRecord`
(hash chain, `seq` autoincrement), `Merchant`, `TermsChunk` (`embedding vector(1536)`).

Benchmark results do **not** go in the database. The runner writes `bench/results/<batchId>.jsonl` and
`bench/results/summary.json`, which are committed, so the scorecard works for judges with no database.

## 8. Environment variables

See [`.env.example`](../.env.example) for the full list with owners and example values.

## 9. Mock API behaviour (Day 0-2)

`pnpm mock:api` serves every endpoint in section 3 on :4000 plus the `/live` socket namespace.

- `GET /api/verifications/demo` always returns a finished VOID verification with 4 checks.
- `POST /orders/:id/authorize` or `/verify` starts a fake run that emits `verify:started`, one
  `verify:check` every ~700 ms, `verify:verdict`, then (live mode) `order:settled`.
- The fake verdict is **CAPTURE** when every `chosenSkus` entry of the attached trace ends in `-BEST` or
  `-BUDGET`, otherwise **VOID**. Unattached orders get VOID.
- State is in memory and resets on restart.
