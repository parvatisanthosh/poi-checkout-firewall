import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./env";
import { errorHandler, notFoundHandler } from "./lib/errors";
import { handle } from "./lib/handler";
import { checkHealth, type HealthChecks } from "./lib/health";
import { logger as defaultLogger, type Logger } from "./lib/logger";
import { getPrisma, type PrismaClient } from "./lib/prisma";
import { getRedis } from "./lib/redis";
import { paypalFromEnv, type PayPal } from "./paypal";
import type { LanguageModel } from "ai";
import { HealthResponse } from "@poi/shared";
import { getEmbeddingModel, hasKeyFor } from "@poi/shared/llm";
import { getSigningKey, type SigningKey } from "./evidence/keys";
import { fetchListingCard } from "./lib/bazaar";
import { modelFromEnv } from "./lib/llm";
import { createInlineQueue, type VerifyQueue } from "./lib/queue";
import { noopEmitter, type Emitter } from "./realtime/emitter";
import { intentsRouter, jwksRouter } from "./routes/intents";
import { ledgerRouter } from "./routes/ledger";
import { merchantsRouter } from "./routes/merchants";
import { ordersRouter } from "./routes/orders";
import { verificationsRouter } from "./routes/verifications";
import { webhooksRouter, type RawBodyRequest } from "./routes/webhooks";
import type { ArenaEngine, Scenario } from "@poi/shared";
import { selectArenaEngine } from "./arena/engine";
import { createInlineArenaQueue, type ArenaQueue } from "./arena/queue";
import { arenaRouter } from "./arena/routes";
import { fetchScenarios, httpArenaBazaar, type ArenaBazaar } from "./lib/bazaar";
import { runShopper } from "@poi/agent";
import type { ArenaTrialDeps } from "./arena/trial.job";
import { noopArenaEmitter, type ArenaEmitter } from "./realtime/arena-emitter";
import { createInlineImmuneQueue, type ImmuneQueue, type ImmuneWorkerDeps } from "./immune/queue";
import { immuneRouter } from "./immune/routes";
import { markVerificationFailed, runVerification, type PipelineDeps } from "./verifier/pipeline";

/** Everything the routes need from the outside world; tests swap in fakes. */
export interface AppDeps extends PipelineDeps {
  prisma: () => PrismaClient;
  paypal?: PayPal;
  health: HealthChecks;
  logger: Logger;
  signingKey: () => Promise<SigningKey>;
  /** Undefined when COMPILER_MODEL or its key is missing (the compiler then uses rules). */
  compilerModel?: LanguageModel;
  /** Mutable: server.ts swaps in the socket emitter and the BullMQ queue at startup. */
  emitter: Emitter;
  queue: VerifyQueue;
  /** PAYPAL_WEBHOOK_ID; webhooks answer 503 without it. */
  webhookId?: string;
  // --- Layer 2 arena ---
  /** The attacker engine (fake until @poi/arena lands). */
  arenaEngine: ArenaEngine;
  arenaEmitter: ArenaEmitter;
  arenaScenarios: () => Promise<Scenario[]>;
  /** Mutable like `queue`: server.ts swaps in BullMQ when Redis is set. */
  arenaQueue: ArenaQueue;
  arenaBazaar: ArenaBazaar;
  arenaShop: ArenaTrialDeps["shop"];
  /** immune.mint: arena reports, POST /immune/report, live VOIDs, human rejects. */
  enqueueMint: ArenaTrialDeps["enqueueMint"];
  /** Mutable like `queue`: server.ts swaps in BullMQ when Redis is set. */
  immuneQueue: ImmuneQueue;
}

/**
 * Production deps from env, with overrides (tests). The default queue runs verifications
 * in-process against these same deps; server.ts replaces it with BullMQ when Redis is set.
 */
export function buildDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const paypal = env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET ? paypalFromEnv() : undefined;
  const embeddingModel =
    env.EMBEDDING_MODEL && hasKeyFor(env.EMBEDDING_MODEL)
      ? getEmbeddingModel(env.EMBEDDING_MODEL)
      : undefined;
  const deps: AppDeps = {
    prisma: getPrisma,
    paypal,
    logger: defaultLogger,
    signingKey: getSigningKey,
    compilerModel: modelFromEnv(env.COMPILER_MODEL),
    judgeModel: modelFromEnv(env.JUDGE_MODEL),
    injectionModel: modelFromEnv(env.JUDGE_MODEL),
    embeddingModel,
    agentModel: (id) => modelFromEnv(id),
    listingCard: (sku) => fetchListingCard(sku),
    emitter: noopEmitter,
    queue: undefined as unknown as VerifyQueue,
    webhookId: env.PAYPAL_WEBHOOK_ID,
    arenaEngine: selectArenaEngine(env.ARENA_ENGINE),
    arenaEmitter: noopArenaEmitter,
    arenaScenarios: () => fetchScenarios(),
    arenaQueue: undefined as unknown as ArenaQueue,
    arenaBazaar: httpArenaBazaar(),
    arenaShop: runShopper,
    enqueueMint: (job) => deps.immuneQueue.enqueueMint(job),
    immuneQueue: undefined as unknown as ImmuneQueue,
    health: {
      db: async () => getPrisma().$queryRaw`SELECT 1`,
      redis: async () => {
        const redis = getRedis();
        if (redis.status === "wait" || redis.status === "end") await redis.connect();
        return redis.ping();
      },
      // A token fetch proves the credentials work; it is cached, so this is cheap.
      paypal: paypal ? () => paypal.tokens.getToken() : undefined,
    },
    ...overrides,
  };
  deps.immuneQueue ??= createInlineImmuneQueue(immuneWorkerDeps(deps));
  deps.arenaQueue ??= createInlineArenaQueue(arenaJobDeps(deps), env.ARENA_CONCURRENCY);
  deps.queue ??= createInlineQueue(
    (id) => runVerification(deps, id),
    (id, err) => markVerificationFailed(deps, id, err),
  );
  return deps;
}

const REQUEST_ID = /^[\w-]{1,64}$/;

export function createApp(deps: AppDeps = buildDeps()) {
  const app = express();

  if (env.NODE_ENV === "production") app.set("trust proxy", 1); // behind Render's proxy
  app.use(helmet());
  app.use(
    cors({
      origin: env.WEB_ORIGIN.split(",").map((o) => o.trim()),
      methods: ["GET", "POST"],
    }),
  );
  app.use(
    pinoHttp({
      logger: deps.logger,
      // Reuse a caller's X-Request-Id if it looks sane, else mint one; echo it back.
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id =
          typeof incoming === "string" && REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === "/api/health" },
      // Keep request logs lean: no headers (they carry auth) and no bodies (traces are big).
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(
    express.json({
      limit: "2mb",
      // Webhook signatures are verified over the original bytes.
      verify: (req, _res, buf) => {
        if ((req as RawBodyRequest).url?.startsWith("/api/webhooks/"))
          (req as RawBodyRequest).rawBody = buf.toString("utf8");
      },
    }),
  );

  // Always 200 so a PayPal or Redis blip doesn't make the host restart the API; read `ok`.
  app.get(
    "/api/health",
    handle({ response: HealthResponse }, () => checkHealth(deps.health)),
  );
  app.use("/api", merchantsRouter(deps));
  app.use("/api", intentsRouter(deps));
  app.use("/api", ordersRouter(deps));
  app.use("/api", verificationsRouter(deps));
  app.use("/api", ledgerRouter(deps));
  app.use("/api", webhooksRouter(deps));
  app.use("/api", arenaRouter(deps));
  app.use("/api", immuneRouter(deps));
  app.use(jwksRouter(deps));
  app.use("/api", jwksRouter(deps));

  app.use("/api", notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** The arena jobs' view of the deps. Getters, so a later swap (socket emitter) is picked up. */
export function arenaJobDeps(deps: AppDeps) {
  return {
    prisma: deps.prisma,
    get engine() {
      return deps.arenaEngine;
    },
    get emitter() {
      return deps.arenaEmitter;
    },
    logger: deps.logger,
    scenarios: () => deps.arenaScenarios(),
    // real trial (Q3)
    pipeline: deps,
    get bazaar() {
      return deps.arenaBazaar;
    },
    bazaarUrl: env.BAZAAR_URL,
    shop: (o: Parameters<ArenaTrialDeps["shop"]>[0]) => deps.arenaShop(o),
    get compilerModel() {
      return deps.compilerModel;
    },
    enqueueMint: (job: Parameters<ArenaTrialDeps["enqueueMint"]>[0]) => deps.enqueueMint(job),
  };
}

/** The immune jobs' view of the deps (getters, so the socket emitter swap is picked up). */
export function immuneWorkerDeps(deps: AppDeps): ImmuneWorkerDeps {
  return {
    prisma: deps.prisma,
    signingKey: deps.signingKey,
    get embeddingModel() {
      return deps.embeddingModel;
    },
    get emitter() {
      return deps.arenaEmitter;
    },
    logger: deps.logger,
    benignSetPath: env.IMMUNE_BENIGN_SET,
    thresholds: { jaccard: env.IMMUNE_JACCARD, cosine: env.IMMUNE_COSINE },
  };
}
