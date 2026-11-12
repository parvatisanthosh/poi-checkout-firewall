// End-to-end against real Postgres (RUN_DB_TESTS=1) with a fake PayPal: attach -> authorize ->
// checks -> verdict -> settlement -> evidence -> /verify, plus decisions, retries, ledger,
// chain tampering and webhooks. Evidence tests live in this one file so nothing else appends
// to the chain while it is being tampered with.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPoiClient, demoTraceFor, type PoiClient } from "./pipeline-helpers";
import { merchants } from "@poi/shared/fixtures";
import { buildDeps, createApp, type AppDeps } from "../src/app";
import { validateChain } from "../src/evidence/chain";
import { loadSigningKey, type SigningKey } from "../src/evidence/keys";
import { createInlineQueue } from "../src/lib/queue";
import { disconnectPrisma, getPrisma } from "../src/lib/prisma";
import { PayPalError, type PayPal, type PayPalOrder } from "../src/paypal";
import type { Emitter } from "../src/realtime/emitter";
import { markVerificationFailed, runVerification } from "../src/verifier/pipeline";
import { testSigningKey } from "./helpers";
import type { MintJob } from "../src/immune/mint.job";
import { preserveMerchantRisk } from "./risk-guard";

const RUN = Date.now().toString(36);
const fixture = (name: string): PayPalOrder =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "orders", `${name}.json`), "utf8"));

// --- fake PayPal ------------------------------------------------------------------------
const orders = new Map<string, PayPalOrder>();
async function getOrder(id: string) {
  const o = orders.get(id);
  if (!o) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "no such order");
  return o;
}
const calls = { authorize: [] as string[], capture: [] as string[], void: [] as string[] };
let failNextCapture = false;
const fakePayPal = {
  tokens: { getToken: async () => "tok", invalidate() {} },
  getOrder,
  async authorizeOrder(id: string) {
    calls.authorize.push(id);
    const order = await getOrder(id);
    return {
      authorizationId: `AUTH-${id}`,
      authorization: { id: `AUTH-${id}`, status: "CREATED" },
      order,
    };
  },
  async captureAuthorization(authId: string) {
    if (failNextCapture) {
      failNextCapture = false;
      throw new PayPalError(503, "SERVICE_UNAVAILABLE", "try again");
    }
    calls.capture.push(authId);
    return { id: `CAP-${authId}`, status: "COMPLETED" };
  },
  async voidAuthorization(authId: string) {
    calls.void.push(authId);
    return { id: authId, status: "VOIDED" };
  },
  async verifyWebhookSignature(headers: Record<string, string | undefined>) {
    return headers["paypal-transmission-sig"] === "good-sig";
  },
} as unknown as PayPal;

const events: Array<{ type: string; orderId: string; payload: unknown }> = [];
const recorder: Emitter = {
  started: (p) => void events.push({ type: "started", orderId: p.orderId, payload: p }),
  check: (p) => void events.push({ type: "check", orderId: p.orderId, payload: p }),
  verdict: (p) => void events.push({ type: "verdict", orderId: p.orderId, payload: p }),
  settled: (p) => void events.push({ type: "settled", orderId: p.orderId, payload: p }),
};

const askHumanJudge = () =>
  new MockLanguageModelV4({
    doGenerate: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            findings: [
              {
                check: "semantic",
                outcome: "warn",
                severity: "high",
                field: "/lines/0/name",
                reason: "Unclear whether this hub has 4K at 60Hz.",
                confidence: 0.8,
              },
            ],
          }),
        },
      ],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });

describe.runIf(process.env.RUN_DB_TESTS === "1")("pipeline (real DB, fake PayPal)", () => {
  let deps: AppDeps;
  let key: SigningKey;
  let poi: PoiClient;
  let baseUrl = "";
  let intentId = "";
  let restoreRisk: () => Promise<void> = async () => {};
  const mints: MintJob[] = [];
  let server: ReturnType<typeof createServer>;

  let placed = 0;
  const place = (name: string) => {
    const base = fixture(name);
    const id = `${base.id}-${RUN}-${placed++}`;
    orders.set(id, { ...base, id });
    return id;
  };
  const attach = async (name: string, mode: "live" | "dry-run", chosen = "HUB-BEST") => {
    const id = place(name);
    await poi.attachOrder(id, { intentId, agentTrace: demoTraceFor(chosen), mode });
    return id;
  };

  beforeAll(async () => {
    // Prefer the real key so test rows in a dev DB show valid signatures; CI has none.
    key = process.env.POI_SIGNING_JWK
      ? await loadSigningKey(process.env.POI_SIGNING_JWK)
      : await testSigningKey();
    const db = getPrisma();
    for (const m of merchants)
      await db.merchant.upsert({ where: { id: m.id }, create: m, update: m });
    restoreRisk = await preserveMerchantRisk(
      db,
      merchants.map((m) => m.id),
    );
    deps = buildDeps({
      // Layer 2: record live-VOID mints instead of growing a dev database's immune memory
      enqueueMint: async (job) => void mints.push(job),
      paypal: fakePayPal,
      signingKey: async () => key,
      compilerModel: undefined,
      judgeModel: undefined,
      injectionModel: undefined,
      embeddingModel: undefined,
      agentModel: () => undefined,
      listingCard: async () => undefined,
      emitter: recorder,
      webhookId: "WH-TEST",
    });
    deps.queue = createInlineQueue(
      (id) => runVerification(deps, id),
      (id, err) => markVerificationFailed(deps, id, err),
      10,
    );
    server = createServer(createApp(deps));
    await new Promise<void>((r) => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    poi = createPoiClient({ baseUrl });
    const { draft } = await poi.compileIntent(
      "USB-C hub under $40 with 4K HDMI, one-time, new only",
    );
    intentId = (await poi.signIntent(draft)).intentId;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await restoreRisk();
    await disconnectPrisma();
  });

  it("live: a hidden subscription is VOIDED on PayPal, streamed, and recorded", async () => {
    const orderId = await attach("hidden-subscription", "live");
    const { authorizationId, verificationId } = await poi.authorizeOrder(orderId);
    expect(authorizationId).toBe(`AUTH-${orderId}`);
    const v = await poi.waitForVerification(verificationId, { intervalMs: 20 });

    expect(v).toMatchObject({
      status: "DONE",
      verdict: "VOID",
      mode: "live",
      settlement: { action: "VOIDED" },
    });
    expect(v.summary).toMatch(/^Voided: /);
    expect(calls.void).toContain(authorizationId);
    expect(calls.capture).not.toContain(authorizationId);
    // Layer 2: a live VOID with a recognisable trick feeds immune memory
    expect(mints).toContainEqual({ orderId, family: "subscription", source: "live-void" });

    const mine = events.filter((e) => e.orderId === orderId).map((e) => e.type);
    expect(mine[0]).toBe("started");
    expect(mine.slice(-2)).toEqual(["verdict", "settled"]);
    expect(mine.filter((t) => t === "check").length).toBe(v.checks.length);

    const record = await poi.getVerifyRecord(orderId);
    expect(record).toMatchObject({
      chainValid: true,
      signatureValid: true,
      publicJwk: key.publicJwk,
    });
    expect(record.order?.merchantId).toBe("nexhub");
    expect(record.evidence?.hash).toBe(v.evidenceHash);
    expect(record.evidence?.payload).toMatchObject({
      kind: "verification",
      verdict: "VOID",
      orderId,
      settlement: { action: "VOIDED" },
    });
  });

  it("live: a benign order is CAPTURED once, and authorize is idempotent", async () => {
    const orderId = await attach("benign", "live");
    const first = await poi.authorizeOrder(orderId);
    const v = await poi.waitForVerification(first.verificationId, { intervalMs: 20 });
    expect(v).toMatchObject({ verdict: "CAPTURE", settlement: { action: "CAPTURED" } });
    const again = await poi.authorizeOrder(orderId);
    expect(again).toEqual(first);
    expect(calls.authorize.filter((id) => id === orderId)).toHaveLength(1);
    expect(calls.capture.filter((id) => id === first.authorizationId)).toHaveLength(1);
  });

  it("dry-run never touches the money, even for a VOID", async () => {
    const orderId = await attach("lookalike-seller", "dry-run");
    const { verificationId } = await poi.verifyOrder(orderId);
    const v = await poi.waitForVerification(verificationId, { intervalMs: 20 });
    expect(v).toMatchObject({ verdict: "VOID", mode: "dry-run", settlement: { action: "NONE" } });
    expect(v.summary).toMatch(/^Would void: /);
    expect(calls.void.some((a) => a.includes(orderId))).toBe(false);
    await expect(poi.authorizeOrder(orderId)).rejects.toMatchObject({
      status: 409,
      code: "ORDER_IS_DRY_RUN",
    });
  });

  it("a failed capture is retried with the stored verdict, not a fresh judgment", async () => {
    failNextCapture = true;
    const orderId = await attach("injection-only", "live");
    const { verificationId, authorizationId } = await poi.authorizeOrder(orderId);
    const v = await poi.waitForVerification(verificationId, { intervalMs: 20 });
    expect(v).toMatchObject({ verdict: "CAPTURE", settlement: { action: "CAPTURED" } });
    expect(calls.capture.filter((a) => a === authorizationId)).toHaveLength(1);
    expect(await getPrisma().evidenceRecord.count({ where: { verificationId } })).toBe(1);
  });

  it("ASK_HUMAN waits; the human's decision settles and extends the chain", async () => {
    deps.judgeModel = askHumanJudge();
    try {
      const orderId = await attach("benign", "live");
      const { verificationId, authorizationId } = await poi.authorizeOrder(orderId);
      const v = await poi.waitForVerification(verificationId, { intervalMs: 20 });
      expect(v).toMatchObject({ verdict: "ASK_HUMAN", settlement: { action: "PENDING_HUMAN" } });
      expect(calls.capture).not.toContain(authorizationId);

      const decided = await poi.decide(verificationId, "VOID");
      expect(decided.settlement).toMatchObject({ action: "VOIDED" });
      expect(calls.void).toContain(authorizationId);
      await expect(poi.decide(verificationId, "CAPTURE")).rejects.toMatchObject({ status: 409 });

      const ev = await getPrisma().evidenceRecord.findMany({
        where: { verificationId },
        orderBy: { seq: "asc" },
      });
      expect(ev.map((e) => (e.payload as { kind: string }).kind)).toEqual([
        "verification",
        "decision",
      ]);
      expect((ev[1]!.payload as { humanDecision: string }).humanDecision).toBe("VOID");
      expect((await poi.getVerifyRecord(orderId)).chainValid).toBe(true);
    } finally {
      deps.judgeModel = undefined;
    }
  });

  it("the ledger pages newest-first with a cursor", async () => {
    const p1 = await poi.getLedger({ limit: 2 });
    expect(p1.rows).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await poi.getLedger({ limit: 2, cursor: p1.nextCursor! });
    const ids = new Set(p1.rows.map((r) => r.orderId));
    expect(p2.rows.every((r) => !ids.has(r.orderId))).toBe(true);
    expect(p1.rows[0]!.createdAt >= p2.rows[0]!.createdAt).toBe(true);
    const dry = await poi.getLedger({ mode: "dry-run", limit: 200 });
    expect(dry.rows.every((r) => r.mode === "dry-run")).toBe(true);
    const voided = (await poi.getLedger({ limit: 200 })).rows.find((r) =>
      r.orderId.startsWith("FX1SUBSCRIPTN01A"),
    );
    expect(voided).toMatchObject({
      verdict: "VOID",
      settlement: "VOIDED",
      merchantDisplayName: "Nexhub Store",
    });
    expect(voided?.topReason).toBeTruthy();
  });

  it("tampering with one stored payload breaks the chain exactly there", async () => {
    const db = getPrisma();
    const tail = await db.evidenceRecord.findFirstOrThrow({ orderBy: { seq: "desc" } });
    const target = await db.evidenceRecord.findFirstOrThrow({
      where: { seq: { lt: tail.seq } },
      orderBy: { seq: "desc" },
    });
    expect((await validateChain(db, key.publicKey)).chainValid).toBe(true);
    const original = JSON.stringify(target.payload);
    // Flip the verdict to something it was not (other test files, e.g. the arena, append
    // records concurrently, so the target may already say CAPTURE).
    const flipped = JSON.stringify(
      (target.payload as { verdict?: string }).verdict === "CAPTURE" ? "VOID" : "CAPTURE",
    );
    await db.$executeRaw`UPDATE "EvidenceRecord" SET payload = jsonb_set(payload, '{verdict}', ${flipped}::jsonb) WHERE seq = ${target.seq}`;
    try {
      const report = await validateChain(db, key.publicKey);
      expect(report).toMatchObject({ chainValid: false, brokenAt: target.seq });
    } finally {
      await db.$executeRaw`UPDATE "EvidenceRecord" SET payload = ${original}::jsonb WHERE seq = ${target.seq}`;
    }
    expect((await validateChain(db, key.publicKey)).chainValid).toBe(true);
    // Three full-chain validations: a dev database's append-only chain grows with every run.
  }, 60_000);

  it("webhooks: verified, once-only, forward-only", async () => {
    const orderId = await attach("protection-plan", "live");
    await poi
      .authorizeOrder(orderId)
      .then((r) => poi.waitForVerification(r.verificationId, { intervalMs: 20 }));
    const post = (event: object, sig = "good-sig") =>
      fetch(`${baseUrl}/api/webhooks/paypal`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
          "paypal-transmission-id": "t-1",
          "paypal-transmission-sig": sig,
          "paypal-transmission-time": new Date().toISOString(),
        },
        body: JSON.stringify(event),
      });
    const voided = {
      id: `WH-${RUN}-1`,
      event_type: "PAYMENT.AUTHORIZATION.VOIDED",
      resource: { id: `AUTH-${orderId}`, status: "VOIDED" },
    };
    expect((await post(voided, "forged")).status).toBe(400);
    expect(await (await post(voided)).json()).toEqual({ ok: true, duplicate: false });
    expect(await (await post(voided)).json()).toEqual({ ok: true, duplicate: true });
    const late = {
      id: `WH-${RUN}-2`,
      event_type: "CHECKOUT.ORDER.APPROVED",
      resource: { id: orderId, status: "APPROVED" },
    };
    await post(late);
    expect(
      (await getPrisma().orderRecord.findUniqueOrThrow({ where: { id: orderId } })).paypalStatus,
    ).toBe("VOIDED");
  });
});
