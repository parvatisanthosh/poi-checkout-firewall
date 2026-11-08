/**
 * Mock POI API (docs/CONTRACTS.md section 9). In-memory, resets on restart.
 * Lets the web app and bench be built before the real API exists.
 */
import { createServer, type Server as HttpServer } from "node:http";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { Server as IoServer } from "socket.io";
import { z } from "zod";
import {
  CAPTURE_SUMMARY,
  DEMO_JWS,
  DEMO_SPEC_HASH,
  VOID_SUMMARY,
  captureChecks,
  captureOrder,
  demoIntentRecord,
  demoMandate,
  demoVoidVerification,
  merchants,
  mockPublicJwk,
  poisonedTrace,
  voidChecks,
  voidOrder,
} from "../src/fixtures";
import {
  AttachOrderRequest,
  CompileIntentRequest,
  DecisionRequest,
  LedgerQuery,
  SignIntentRequest,
  VerifyOrderRequest,
  type AgentTrace,
  type Ambiguity,
  type CheckResult,
  type IntentMandate,
  type IntentRecord,
  type IntentSpec,
  type LedgerRow,
  type RunMode,
  type VerificationResult,
} from "../src/schemas";
import {
  EVENTS,
  LIVE_NAMESPACE,
  orderRoom,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "../src/events";

export interface MockOptions {
  /** Delay between streamed checks. Tests set this to ~0. */
  checkIntervalMs?: number;
}

interface StoredIntent {
  record: IntentRecord;
  mandate: IntentMandate;
  jws: string;
}
interface StoredOrder {
  orderId: string;
  intentId: string;
  agentTrace: AgentTrace;
  mode: RunMode;
  runTag?: string;
  createdAt: string;
  verificationIds: string[];
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const STAGES = ["deterministic", "semantic", "rag", "shadow"];

/** CAPTURE when every chosen SKU is an honest benign listing, else VOID. */
function isBenign(trace: AgentTrace | undefined) {
  return (
    !!trace &&
    trace.chosenSkus.length > 0 &&
    trace.chosenSkus.every((s) => /-(BEST|BUDGET)$/.test(s))
  );
}

/** Very small keyword "compiler" -- the real one is an LLM (task P3). */
export function mockCompile(text: string): { draft: IntentSpec; ambiguities: Ambiguity[] } {
  const ambiguities: Ambiguity[] = [];
  const budget = /\$\s?(\d+(?:\.\d{1,2})?)/.exec(text);
  if (!budget) {
    ambiguities.push({ field: "maxTotal", question: "What's the most you want to spend, all-in?" });
  }
  const lower = text.toLowerCase();
  const category = lower.includes("hub")
    ? "usb-c hub"
    : lower.includes("earbud")
      ? "wireless earbuds"
      : lower.includes("stand")
        ? "laptop stand"
        : "unknown";
  if (category === "unknown") {
    ambiguities.push({ field: "category", question: "What kind of product are you looking for?" });
  }
  const mustHave: string[] = [];
  if (/4k/i.test(text)) mustHave.push("4K HDMI");
  if (/noise[- ]cancel|anc/i.test(text)) mustHave.push("ANC");
  if (/alumin/i.test(text)) mustHave.push("aluminium");
  const subscriptionOk = /subscription (is )?(ok|fine|allowed)/i.test(text);
  const refurbOk = /(refurb|renewed)[a-z]* (is )?(ok|fine)/i.test(text);
  if (!/one-time|no subscription/i.test(text) && !subscriptionOk) {
    ambiguities.push({
      field: "oneTimeOnly",
      question: "Is a subscription or recurring charge ever OK?",
      resolvedWith: "default: one-time only",
    });
  }
  const qty = /\b(\d+) of (them|those)\b/i.exec(text);
  const draft: IntentSpec = {
    version: "poi.intent/1",
    rawText: text,
    category,
    mustHave,
    niceToHave: [],
    quantity: qty ? Number(qty[1]) : 1,
    maxTotal: {
      currency: "USD",
      value: budget ? Number(budget[1]).toFixed(2) : "0.00",
    },
    oneTimeOnly: !subscriptionOk,
    allowedConditions: refurbOk ? ["new", "renewed"] : ["new"],
    allowAddOns: false,
    blockedMerchants: [],
    humanPresent: true,
    ambiguities,
  };
  return { draft, ambiguities };
}

export function createMockApp(opts: MockOptions = {}) {
  const checkIntervalMs = opts.checkIntervalMs ?? 700;
  const intents = new Map<string, StoredIntent>();
  const orders = new Map<string, StoredOrder>();
  const verifications = new Map<string, VerificationResult>();
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`;

  // Seed the demo so /ledger, /verify and /verifications/demo work immediately.
  intents.set(demoIntentRecord.intentId, {
    record: demoIntentRecord,
    mandate: demoMandate,
    jws: DEMO_JWS,
  });
  orders.set(voidOrder.orderId, {
    orderId: voidOrder.orderId,
    intentId: demoIntentRecord.intentId,
    agentTrace: poisonedTrace,
    mode: "live",
    createdAt: "2026-11-08T12:00:05.000Z",
    verificationIds: [demoVoidVerification.verificationId],
  });
  verifications.set(demoVoidVerification.verificationId, demoVoidVerification);

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  const parse = <T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> => {
    const r = schema.safeParse(data);
    if (!r.success) throw new HttpError(400, "VALIDATION_ERROR", z.prettifyError(r.error));
    return r.data;
  };
  const getOrder = (orderId: string) => {
    const o = orders.get(orderId);
    if (!o) throw new HttpError(404, "ORDER_NOT_FOUND", `Order ${orderId} has not been attached`);
    return o;
  };

  // -- live namespace ------------------------------------------------------
  const httpServer: HttpServer = createServer(app);
  const io = new IoServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: true },
  });
  const live = io.of(LIVE_NAMESPACE);
  live.on("connection", (socket) => {
    socket.on(EVENTS.subscribe, ({ orderId }) => {
      if (typeof orderId === "string") void socket.join(orderRoom(orderId));
    });
  });

  function startRun(order: StoredOrder, mode: RunMode): VerificationResult {
    const benign = isBenign(order.agentTrace);
    const checks: CheckResult[] = benign ? captureChecks : voidChecks;
    const verdict = benign ? "CAPTURE" : "VOID";
    const v: VerificationResult = {
      verificationId: nextId("ver"),
      orderId: order.orderId,
      intentId: order.intentId,
      mode,
      status: "QUEUED",
      checks: [],
    };
    verifications.set(v.verificationId, v);
    order.verificationIds.push(v.verificationId);
    const room = live.to(orderRoom(order.orderId));
    const base = { verificationId: v.verificationId, orderId: order.orderId };

    let t = Math.min(300, checkIntervalMs);
    setTimeout(() => {
      v.status = "RUNNING";
      room.emit(EVENTS.verifyStarted, { ...base, stages: STAGES });
    }, t);
    for (const check of checks) {
      t += checkIntervalMs;
      setTimeout(() => {
        v.checks.push(check);
        room.emit(EVENTS.verifyCheck, { ...base, check });
      }, t);
    }
    t += checkIntervalMs;
    setTimeout(() => {
      v.status = "DONE";
      v.verdict = verdict;
      v.summary = benign ? CAPTURE_SUMMARY : VOID_SUMMARY;
      v.evidenceHash = DEMO_SPEC_HASH;
      v.settlement = { action: "NONE" }; // live mode settles a moment later
      room.emit(EVENTS.verifyVerdict, { ...base, verdict, summary: v.summary });
      if (mode === "live") {
        setTimeout(
          () => {
            const action = verdict === "CAPTURE" ? "CAPTURED" : "VOIDED";
            const paypalStatus = verdict === "CAPTURE" ? "COMPLETED" : "VOIDED";
            v.settlement = { action, paypalStatus };
            room.emit(EVENTS.orderSettled, { orderId: order.orderId, action, paypalStatus });
          },
          Math.min(500, checkIntervalMs),
        );
      }
    }, t);
    return v;
  }

  const r = express.Router();

  r.get("/health", (_req, res) => {
    res.json({ ok: true, db: true, redis: true, paypal: true });
  });

  r.post("/intents/compile", (req, res) => {
    const { text } = parse(CompileIntentRequest, req.body);
    res.json(mockCompile(text));
  });

  r.post("/intents", (req, res) => {
    const { spec } = parse(SignIntentRequest, req.body);
    const intentId = nextId("int");
    const createdAt = new Date().toISOString();
    const stored: StoredIntent = {
      record: {
        intentId,
        rawText: spec.rawText,
        spec,
        specHash: DEMO_SPEC_HASH,
        status: "SIGNED",
        createdAt,
      },
      mandate: {
        ...demoMandate,
        intentId,
        naturalLanguageDescription: spec.rawText,
        amountRange: { max: spec.maxTotal },
        recurrence: spec.oneTimeOnly ? "none" : "allowed",
        allowedPayees: spec.allowedMerchants ?? "any-verified",
        allowedConditions: spec.allowedConditions,
        allowAddOns: spec.allowAddOns,
        humanPresent: spec.humanPresent,
        issuedAt: createdAt,
      },
      jws: DEMO_JWS,
    };
    intents.set(intentId, stored);
    res.status(201).json({ intentId, mandate: stored.mandate, jws: stored.jws });
  });

  r.get("/intents/:id", (req, res) => {
    const it = intents.get(req.params.id);
    if (!it) throw new HttpError(404, "INTENT_NOT_FOUND", `Intent ${req.params.id} not found`);
    res.json({ intent: it.record, mandate: it.mandate, jws: it.jws });
  });

  r.post("/orders/:orderId/attach", (req, res) => {
    const body = parse(AttachOrderRequest, req.body);
    if (!intents.has(body.intentId)) {
      throw new HttpError(404, "INTENT_NOT_FOUND", `Intent ${body.intentId} not found`);
    }
    const orderId = req.params.orderId;
    orders.set(orderId, {
      orderId,
      intentId: body.intentId,
      agentTrace: body.agentTrace,
      mode: body.mode,
      runTag: body.runTag,
      createdAt: new Date().toISOString(),
      verificationIds: orders.get(orderId)?.verificationIds ?? [],
    });
    res.json({ ok: true });
  });

  r.post("/orders/:orderId/authorize", (req, res) => {
    const order = getOrder(req.params.orderId);
    const v = startRun(order, "live");
    res.json({ authorizationId: `AUTH-${order.orderId}`, verificationId: v.verificationId });
  });

  r.post("/orders/:orderId/verify", (req, res) => {
    parse(VerifyOrderRequest, req.body);
    const order = getOrder(req.params.orderId);
    const v = startRun(order, "dry-run");
    res.status(202).json({ verificationId: v.verificationId });
  });

  r.get("/verifications/:id", (req, res) => {
    const v = verifications.get(req.params.id);
    if (!v)
      throw new HttpError(404, "VERIFICATION_NOT_FOUND", `Verification ${req.params.id} not found`);
    res.json(v);
  });

  r.post("/verifications/:id/decision", (req, res) => {
    const { decision } = parse(DecisionRequest, req.body);
    const v = verifications.get(req.params.id);
    if (!v)
      throw new HttpError(404, "VERIFICATION_NOT_FOUND", `Verification ${req.params.id} not found`);
    if (v.verdict !== "ASK_HUMAN") {
      throw new HttpError(409, "NOT_PENDING_HUMAN", "Only ASK_HUMAN verifications take a decision");
    }
    const action = decision === "CAPTURE" ? "CAPTURED" : "VOIDED";
    const paypalStatus = decision === "CAPTURE" ? "COMPLETED" : "VOIDED";
    v.settlement = { action, paypalStatus };
    live
      .to(orderRoom(v.orderId))
      .emit(EVENTS.orderSettled, { orderId: v.orderId, action, paypalStatus });
    res.json(v);
  });

  r.get("/ledger", (req, res) => {
    const q = parse(LedgerQuery, req.query);
    const all = [...orders.values()]
      .filter((o) => !q.mode || o.mode === q.mode)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const start = q.cursor ? Number(q.cursor) : 0;
    const page = all.slice(start, start + q.limit);
    const rows: LedgerRow[] = page.map((o) => {
      const v = verifications.get(o.verificationIds.at(-1) ?? "");
      const fixture = isBenign(o.agentTrace) ? captureOrder : voidOrder;
      const topFail = v?.checks.find((c) => c.outcome === "fail");
      return {
        orderId: o.orderId,
        createdAt: o.createdAt,
        mode: o.mode,
        model: o.agentTrace.model,
        merchantDisplayName: fixture.merchantDisplayName,
        total: fixture.total,
        verdict: v?.verdict,
        topReason: topFail?.reason ?? v?.summary,
        settlement: v?.settlement?.action ?? "NONE",
        runTag: o.runTag,
      };
    });
    const next = start + q.limit;
    res.json({ rows, nextCursor: next < all.length ? String(next) : null });
  });

  r.get("/verify/:orderId", (req, res) => {
    const order = getOrder(req.params.orderId);
    const intent = intents.get(order.intentId)?.record ?? demoIntentRecord;
    const v = verifications.get(order.verificationIds.at(-1) ?? "") ?? null;
    const fixture = isBenign(order.agentTrace) ? captureOrder : voidOrder;
    const done = v?.status === "DONE";
    res.json({
      intent,
      order: { ...fixture, orderId: order.orderId },
      verification: v,
      evidence: done
        ? {
            seq: 1,
            prevHash: "0".repeat(64),
            hash: v.evidenceHash ?? DEMO_SPEC_HASH,
            payload: { intentId: intent.intentId, orderId: order.orderId, verdict: v.verdict },
            jws: DEMO_JWS,
            createdAt: order.createdAt,
          }
        : null,
      chainValid: true,
      signatureValid: true,
      publicJwk: mockPublicJwk,
    });
  });

  r.get("/merchants", (_req, res) => {
    res.json(merchants);
  });

  r.get("/.well-known/jwks.json", (_req, res) => {
    res.json({ keys: [mockPublicJwk] });
  });

  r.post("/webhooks/paypal", (_req, res) => {
    res.sendStatus(200);
  });

  app.use("/api", r);

  app.use((_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "No such route")));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: { code: "INTERNAL", message } });
  });

  return { app, httpServer, io };
}
