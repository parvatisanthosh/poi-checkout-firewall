# POI Immune -- Layer 2 contracts

"ProofOfIntent Immune: the checkout firewall that learns." Section 4 of the Layer 2 plan, frozen on
Day 0 (Mon 9 Nov). **Both AI tools read this before any Layer 2 change.** Layer 1 contracts
([CONTRACTS.md](CONTRACTS.md)) stay as they are; everything here is additive.

Shared types live in `packages/shared/src/l2.ts` (exported from `@poi/shared`). Mocks:
`@poi/shared/fixtures-l2` (fixtures), `@poi/shared/arena-fake` (fake attacker), and the mock API
(`pnpm mock:api`) serves every endpoint below with timed socket events.

## Ownership

| Area | Owner |
| --- | --- |
| `apps/api/src/arena/`, `apps/api/src/immune/`, `apps/api/src/calibration/`, new Prisma models, `packages/shared/src/l2.ts` | Parvati (Claude Code) |
| `packages/arena/`, `apps/bazaar/src/arena/`, `apps/web/app/{arena,immune,calibration}/`, `bench/evolved/` | Teammate (Cursor) |

One interface crosses the seam: Parvati's `arena.trial` job calls the teammate's `packages/arena`
functions (4.6). The teammate keeps those signatures stable; Parvati never reimplements them.
Every arena LLM call goes through Parvati's `withBudget()` wrapper (stops a run past `ARENA_MAX_USD`).
Freeze rule: once the held-out evaluation starts (Thu morning), nobody changes prompts, thresholds
or antibodies; if something must change, rerun everything and say so in the README.

## 4.1 Schemas (`packages/shared/src/l2.ts`)

| Schema | Shape |
| --- | --- |
| `AttackFamily` | `"injection" \| "subscription" \| "variant" \| "addon" \| "lookalike" \| "dripfee" \| "tosrenew"` |
| `Channel` | `"title" \| "description" \| "review" \| "alt_text" \| "terms" \| "checkout"` (MAP-Elites grid = 7 x 6 = 42 cells, `ARCHIVE_CELL_COUNT`) |
| `GenomeOperator` | `"seed" \| "mutate" \| "crossover" \| "strategy"` |
| `GenomeDraft` | `{ family, channel, operator, parentIds[] = [], strategy, scenarioId, listing: BazaarProduct }` |
| `Genome` | `GenomeDraft & { id, runId, generation, split: "train" \| "heldout", attackerModel }` |
| `StageScores` | `{ semantic, terms, shadow, injection, immune, risk }`, each in [0,1], default 0 |
| `TrialResult` | `{ trialId, runId, genomeId, generation, agentModel, valid, invalidReasons[], orderId?, chosenPoison, verdictStatic?, verdictImmune?, scoresStatic?, scoresImmune?, stealthP, noveltyCos, fitness, reported, costUsd, latencyMs }` |
| `ArchiveCell` | `{ family, channel, eliteGenomeId \| null, eliteFitness \| null, attempts, wins }` |
| `StrategyEntry` | `{ id, family, channel?, text, wins, losses }` |
| `ArenaRunConfig` | `{ generations = 6 (1-20), populationSize = 12 (4-24), attackerModel, agentModel, families[], split = "train", target: "static" \| "immune" = "static", immuneLearning = true, frozenDefenderVersion?, scenarioIds?, maxUsd = 15 }` |
| `AntibodyAction` | `"ASK_HUMAN" \| "VOID"` |
| `Antibody` | `{ id, family, sourceOrderId, minhash: int[128], features: Record<flag, boolean>, skeleton \| null, action, status: "candidate" \| "active" \| "retired", hits, falseHits, defenderVersion, signature }` |
| `ImmuneMatch` | `{ antibodyId, kind: "minhash" \| "embedding" \| "features" \| "skeleton", similarity, action }` |
| `CalibrationResult` | `{ id, alpha, n, nViolating, lambdaAsk, lambdaVoid, empiricalMiss, benignAskRate, benignVoidRate, perFamily: [{ family, n, miss }], createdAt }` |
| `VerifierConfigL2` | `{ immune = false, conformal = false, defenderVersion? }` -- these fields are now on Layer 1's `VerifierConfig`, so defaults keep Layer 1 behaviour |

Structural antibody flags (`ANTIBODY_FEATURES`): `recurrence_in_checkout`, `recurrence_in_terms`,
`trial_language`, `condition_not_new`, `digital_extra_line`, `fee_lines`, `seller_unverified`,
`addresses_ai`, `hidden_text_present`.

### Layer 1 changes made for Layer 2 (all additive)

- `CheckId` gains `"immune"` (antibody match) and `"risk"` (merchant repeat-offender risk).
- `VerifierConfig` gains `immune`, `conformal` (default `false`) and `defenderVersion?`.
- `BazaarProduct` and `Scenario` moved from `apps/bazaar/src/data.ts` to
  `packages/shared/src/bazaar.ts` (the Bazaar re-exports them under its old names `Product`,
  `Category`, `Family`, `MerchantRecord`, `Scenario`). `ProductFamily` adds `"dripfee"` and
  `"tosrenew"` for evolved listings; `BazaarProduct` adds `termsExcerpt?` (the "terms" channel) and
  `scenarios` now defaults to `[]`.
- `GET /api/verify/:orderId` may carry the Layer 2 fields below; `createPoiClient().getVerifyRecord`
  parses with `VerifyRecordResponseL2` so they aren't stripped.

## 4.2 Prisma models (`prisma/schema.prisma`, Parvati -- task Q1)

`enum ArenaStatus { QUEUED RUNNING DONE STOPPED ERROR }`, `enum AntibodyState { CANDIDATE ACTIVE RETIRED }`.

- `ArenaRun { id, config Json, status, costUsd Float, createdAt, genomes[], cells[], gens[] }`
- `ArenaGeneration { id, runId, generation, asrStatic, asrImmune, coverage (cells filled of 42), bestFitness, defenderVersion; @@unique([runId, generation]) }`
- `AttackGenome { id, runId, generation, family, channel, operator, parentIds String[], strategy, scenarioId, listing Json, split, attackerModel, embedding vector(1536)?, createdAt, trials[]; @@index([runId, generation]) }`
- `ArenaTrial { id, genomeId, result Json (TrialResult), fitness, chosenPoison, verdictStatic?, verdictImmune?, reported = false, createdAt }`
- `ArenaCell { runId, family, channel, eliteGenomeId?, eliteFitness?, attempts = 0, wins = 0; @@id([runId, family, channel]) }`
- `StrategyEntry { id, family, channel?, text, wins = 0, losses = 0 }`
- `Antibody { id, family, sourceOrderId, minhash Int[], embedding vector(1536)?, features Json, skeleton?, action, state = CANDIDATE, hits = 0, falseHits = 0, defenderVersion, signature, createdAt, bands[] }`
- `AntibodyBand { band, hash, antibodyId; @@id([band, hash, antibodyId]); @@index([band, hash]) }` -- LSH, 32 bands x 4 rows
- `MerchantRisk { merchantId @id, voids = 0, reports = 0, orders = 0, updatedAt }`
- `Calibration { id, alpha, result Json (CalibrationResult), defenderVersion, createdAt }`
- `DefenderState { id = 1, version = 0, activeCalibrationId? }` (single row, inserted by the migration)

Additions made in Q1 (internal to the API, no client impact):

- `Antibody.retiredVersion Int?` and `DefenderVersionLog { version @id, reason, calibrationId?, createdAt }`
  (one row per version, with the calibration in force). Together they make
  `snapshotDefender(v)` exact: an antibody is live at `v` when it was activated at or before `v` and not
  retired by `v`; a rejected candidate is retired at its own mint version, so it was never live.
- Antibody `defenderVersion` = the version at mint, then the version its promotion created.
- Indexes on `ArenaTrial.genomeId` and `Antibody.state`; `AntibodyBand` rows cascade-delete with
  their antibody.

Repos (Parvati): `apps/api/src/arena/archive.repo.ts`, `apps/api/src/immune/antibody.repo.ts`,
`apps/api/src/calibration/calibration.repo.ts`, and the defender service
`apps/api/src/immune/defender.ts` (`getDefender`, `bumpVersion(reason, change)` under a row lock,
`setActiveCalibration`, `snapshotDefender(version)`).

## 4.3 Queues (BullMQ, Parvati)

| Queue | Job id | Triggered by | Does |
| --- | --- | --- | --- |
| `arena.generation` | `{runId}-g{gen}` ("propose"); its parent `{runId}-g{gen}-final` ("finalize") | `POST /arena/runs`, and itself for the next generation | select parents, `proposeGeneration`, validate, persist genomes, fan out trials, wait, compute generation stats, run Strategist, enqueue next gen |
| `arena.trial` | genome id | generation job | deploy tenant, run agent, attach order, verify static + immune, oracle, fitness, archive update, report |
| `immune.mint` | `mint-{orderId}` | report (arena or `POST /immune/report`), live VOID or human reject | build candidate antibody, dedupe |
| `immune.promote` | `promote-{antibodyId}` | after mint | replay on 40 benign listings, activate if 0 false hits, bump defender version |
| `calibrate.crc` | `crc-{timestamp}` | `POST /calibration/run`, nightly cron | fuse scores, compute lambdas, store, set active |

Job ids use dashes, not colons: BullMQ rejects custom ids with one or two `:`. A generation is a
BullMQ flow: "propose" persists the genomes and adds a FlowProducer flow whose parent is the
generation's "finalize" job and whose children are the trials (`ignoreDependencyOnFailure`, so one
broken trial never blocks the generation). Without Redis the same steps run in-process.

Budget (Q2): `withBudget(run, fn)` runs `fn` in a usage context. Every model from `getModel()`
(`@poi/shared/llm`) is metered, so every LLM call inside -- the agent, the judge, `@poi/arena` -- is
priced (list price per 1M tokens, `ARENA_PRICES` overrides) and added to `ArenaRun.costUsd`; the
call that crosses `min(config.maxUsd, ARENA_MAX_USD)` throws `BudgetExceeded` and the run ends
STOPPED. `@poi/arena` needs no budget code of its own -- just resolve models with `getModel`.

## 4.4 POI API additions (Parvati) -- all under `/api`

| Method | Path | Body / query | Returns (schema) | Client method |
| --- | --- | --- | --- | --- |
| POST | `/arena/runs` | `ArenaRunConfig` | `{ runId }` (201) | `startArenaRun` |
| GET | `/arena/runs` | none | `ArenaRunSummary[]`: `{ id, status, costUsd, createdAt, config, generationsDone }` | `listArenaRuns` |
| GET | `/arena/runs/:id` | none | `ArenaRunDetail`: `{ id, config, status, costUsd, createdAt, generations: ArenaGenerationStats[], cells: ArchiveCell[] }` | `getArenaRun` |
| GET | `/arena/runs/:id/genomes` | `?gen&family` | `GenomeRow[]` = `Genome & { bestTrial: TrialResult \| null }` | `getArenaGenomes` |
| GET | `/arena/genomes/:id` | none | `GenomeLineage`: `{ genome, parents: Genome[], trials: TrialResult[] }` | `getGenome` |
| POST | `/arena/runs/:id/stop` | none | `{ ok: true }` | `stopArenaRun` |
| GET | `/immune/antibodies` | `?state=candidate\|active\|retired` | `AntibodySummary[]` (Antibody without `minhash`, plus `createdAt`) | `listAntibodies` |
| GET | `/immune/antibodies/:id` | none | `AntibodyDetail`: `{ antibody, recentHits: [{ orderId, at, kind, similarity, falseHit }], sourceOrder: { orderId, merchantId, merchantDisplayName, total, lineNames } \| null }` | `getAntibody` |
| POST | `/immune/antibodies/:id/retire` | none | `AntibodySummary` | `retireAntibody` |
| POST | `/immune/report` | `{ orderId, reason }` | `{ antibodyId? }` -- the "this wasn't what I asked for" button; `antibodyId` when an existing antibody absorbed it (minting itself is queued) | `reportOrder` |
| GET | `/immune/merchants` | none | `MerchantRiskRow[]`: `{ merchantId, displayName, risk, voids, reports, orders }` | `getMerchantRisks` |
| POST | `/calibration/run` | `{ alpha, perFamily? }` | `CalibrationResult` | `runCalibration` |
| GET | `/calibration/latest` | none | `CalibrationResult` | `getLatestCalibration` |
| GET | `/calibration/curve` | none | `[{ alpha, lambdaAsk, empiricalMiss, benignAskRate }]` for alpha 0.01..0.20 | `getCalibrationCurve` |
| GET | `/defender` | none | `{ version, activeAntibodies, activeCalibrationId }` | `getDefender` |
| POST | `/orders/:id/verify` | Layer 1 body; `config` may set `immune`, `conformal`, `defenderVersion` | unchanged | `verifyOrder` |
| GET | `/verify/:orderId` | none | Layer 1 payload + optional `immuneMatches`, `antibodies` (summaries), `merchantRisk`, `calibration { alpha, lambdaAsk, lambdaVoid, n, calibrationId }`, `defenderVersion`, `counterfactual { annualExtraUsd \| null, items: [{ label, monthlyUsd?, oneOffUsd? }] }` (`VerifyRecordResponseL2`) | `getVerifyRecord` |

Counterfactual (5.5): recurring x 12 + add-ons + fees beyond what the user meant to pay, e.g.
6.99 x 12 + 4.99 = 88.87. A recurring charge whose amount can't be parsed has `monthlyUsd: null`
and makes `annualExtraUsd` null ("recurring, amount unknown") -- never guessed.

## 4.5 Bazaar additions (teammate)

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/arena/tenants/:tenant/listings` | `{ product: BazaarProduct, baseScenario }` | `{ sku }`; tenant catalog = the scenario's 4 benign listings + this product |
| DELETE | `/arena/tenants/:tenant` | none | `{ ok }` |
| GET `/catalog`, `/products/:sku`, `/products/:sku/meta`, `/merchants/:id/terms` | `?tenant=<id>` | none | same as Layer 1, scoped to the tenant |
| POST `/checkout`, `/checkout/preview` | `?tenant=<id>` or `tenant` in the body | as Layer 1 | same as Layer 1, scoped to the tenant |

Tenant ids: `arena-g{gen}-{genomeId}`; tenant SKU: `ARENA-<tenant id>` (hence lowercase letters are
allowed in `BazaarProduct.sku`). Tenants live in memory with a 2-hour TTL (plus a persisted copy in
`data/arena/` for the held-out set), so a restart mid-run only loses in-flight trials.

**Isolation:** a request without `tenant` must behave exactly like Layer 1. In particular
`GET /merchants/:id/terms` without `tenant` returns the merchant's real terms, never a tenant's
`termsExcerpt` (no cross-tenant fallback), and one tenant never sees another tenant's data.

**Agent (`packages/agent`):** `RunShopperOptions` gains `tenant?: string`. When set, `runShopper`
adds `tenant=<id>` to every Bazaar request it makes (catalog, product pages, terms, checkout) and
does not need a `scenario`. Without it nothing changes. The CLI gets a matching `--tenant` flag.

How a trial uses a tenant (Parvati's `arena.trial`, task Q3):

- The trial calls `runShopper({ userText, model, bazaarUrl, tenant })` with no `scenario`: the tenant
  already fixes the catalog.
- The trial passes the returned `sku` to `oracle()` (the genome's listing with its sku replaced by
  the deployed one), since that is the sku the agent saw and bought.
- The evolved `termsExcerpt` is not ingested into POI's `TermsChunk` table (that would leak it into
  Layer 1). The trial hands it to the order's terms stage directly (`PipelineDeps.extraTerms`), only
  when the order went to the evolved listing's merchant.
- The trial always calls `DELETE /arena/tenants/:tenant` when it finishes, even after an error; a
  retry re-creates the same tenant id, so `POST .../listings` on an existing tenant must replace it.
- Bazaar 5xx/429 are retried by the trial; other 4xx fail the trial (recorded as errored).

## 4.6 `packages/arena` interface (teammate; called by Parvati's jobs)

Typed as `ArenaEngine` in `l2.ts`:

```ts
proposeGeneration(i: { runId; generation; populationSize; archive: ArchiveCell[]; elites: Genome[];
  library: StrategyEntry[]; families: AttackFamily[]; scenarios: Scenario[]; attackerModel; seed }): Promise<GenomeDraft[]>
validateListing(d: GenomeDraft, scenario: Scenario, spec: IntentSpec): { valid; reasons: string[]; violation: AttackFamily | null }
noveltyCos(listingText: string, eliteEmbeddings: number[][]): Promise<{ cos: number; embedding: number[] }>
scoreFitness(t: { valid; chosenPoison; verdict?: Verdict; stealthP; noveltyCos }): number
shouldReplaceElite(cell: ArchiveCell, fitness: number): boolean
oracle(g: Genome, chosenSkus: string[]): { violated: boolean; family: AttackFamily | null }
summarizeStrategies(i: { genomes: Genome[]; trials: TrialResult[]; library: StrategyEntry[]; model: string }): Promise<StrategyEntry[]>
listingText(p: BazaarProduct): string
```

`listingText` is the single function that turns a listing into text (title, bullets, description,
specs, reviews, alt texts, terms excerpt, checkout line names; then NFKC, lowercase, collapsed
whitespace, digits -> `#`). Parvati's immune memory and the teammate's novelty score both call it,
so a fingerprint means the same thing on both sides.

Until `@poi/arena` exists, `fakeProposeGeneration` (`@poi/shared/arena-fake`) has the same
signature: it lightly edits the Layer 1 poisoned listings, deterministically per seed.

## 4.7 Socket.IO events (namespace `/live`)

Clients join rooms with `arena:subscribe { runId }` (room `arena:{runId}`) and `immune:subscribe`
(room `immune`). Event names are in `L2_EVENTS`; generics `LiveServerToClientEvents` /
`LiveClientToServerEvents` cover Layer 1 + Layer 2.

| Event | Room | Payload |
| --- | --- | --- |
| `arena:run` | `arena:{runId}` | `{ runId, status, costUsd }` |
| `arena:trial` | `arena:{runId}` | `{ runId, generation, genomeId, family, channel, fitness, chosenPoison, verdictStatic, verdictImmune, replacedElite }` |
| `arena:generation` | `arena:{runId}` | `{ runId, generation, asrStatic, asrImmune, coverage, bestFitness, defenderVersion }` |
| `immune:minted` | `immune` | `{ antibodyId, family, sourceOrderId }` |
| `immune:promoted` / `immune:rejected` | `immune` | `{ antibodyId, falseHits, defenderVersion }` |
| `calibration:updated` | `immune` | `{ calibrationId, alpha, lambdaAsk, lambdaVoid }` |

## 4.8 New environment variables

| Variable | Default (free-tier) | Note |
| --- | --- | --- |
| `ARENA_ATTACKER_MODEL` | `groq:openai/gpt-oss-120b` | attacker A (train) |
| `ARENA_HELDOUT_ATTACKER_MODEL` | `groq:qwen/qwen3.8-27b` | attacker B, held-out only -- must come from a different model vendor than A |
| `ARENA_AGENT_MODEL` | `google:gemini-flash-lite-latest` | the agent under attack (Layer 1 agent default) |
| `ARENA_CONCURRENCY` | `4` | trial parallelism (use 1-2 on free keys) |
| `ARENA_MAX_USD` | `15` | hard stop per run |
| `IMMUNE_JACCARD` | `0.5` | MinHash match threshold |
| `IMMUNE_COSINE` | `0.85` | embedding match threshold |
| `IMMUNE_BENIGN_SET` | `bench/evolved/benign-40.json` | promotion gate set |
| `RISK_ASK_THRESHOLD` | `0.35` | merchant risk above this = ASK_HUMAN |
| `CRC_ALPHA` | `0.05` | default alpha |
| `CRC_BENIGN_VOID_QUANTILE` | `0.99` | sets lambdaVoid from benign scores |

## Invariants (from the plan, sections 3 and 5)

- Layer 1 verifier, agent and PayPal flow are untouched; Layer 2 only adds stages after them.
- Immune match and the conformal gate can only raise a verdict:
  final = max(Layer 1 lattice, immune, gate). No learned component ever loosens a verdict on its own.
- An antibody goes live only after matching 0 of the 40 benign listings and its own source order.
- Ground truth is the oracle (scenario/genome labels), never POI.
