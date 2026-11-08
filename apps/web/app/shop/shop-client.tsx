"use client";

import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Condition,
  IntentSpec,
  PoiApiError,
  type AgentStep,
  type AgentTrace,
  type Ambiguity,
  type CheckResult,
  type NormalizedOrder,
  type SignIntentResponse,
  type VerificationResult,
} from "@poi/shared";
import {
  DEMO_JWS,
  demoMandate,
  demoSpec,
  poisonedTrace,
  VOID_SUMMARY,
  voidChecks,
  voidOrder,
} from "@poi/shared/fixtures";
import { Button, Card, cx, ErrorNote, Pill, Spinner } from "@/components/ui";
import { CheckList, OrderLines, VerdictCard } from "@/components/verification";
import { PAYPAL_CLIENT_ID, poi } from "@/lib/config";
import { useLiveOrder } from "@/lib/live";
import { previewToOrder } from "@/lib/preview";
import { shortHash, specSentences } from "@/lib/spec";

const EXAMPLES = [
  "USB-C hub under $40 with 4K HDMI, one-time purchase, new only",
  "Noise-cancelling earbuds with ANC, keep it under $60 total, no subscriptions, new only",
  "Aluminium laptop stand under $35, new, nothing extra, one-time purchase",
];

type Checkout = { orderId: string; merchantId: string; approveUrl: string };
interface Config {
  models: Array<{ id: string; available: boolean }>;
  scenarios: Array<{ id: string; family: string; userText: string }>;
}

const msg = (err: unknown) =>
  err instanceof PoiApiError
    ? `${err.code}: ${err.message}`
    : err instanceof Error
      ? err.message
      : String(err);

function Step({
  n,
  title,
  active,
  done,
  children,
}: {
  n: number;
  title: string;
  active: boolean;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cx("relative pl-10", !active && !done && "opacity-50")}>
      <span
        className={cx(
          "absolute left-0 top-0 grid h-7 w-7 place-items-center rounded-full text-xs font-bold",
          done ? "bg-capture text-white" : active ? "bg-brand text-white" : "bg-line text-muted",
        )}
      >
        {done ? "✓" : n}
      </span>
      <h2 className="mb-3 text-lg font-semibold tracking-tight">{title}</h2>
      {(active || done) && children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Step 1: intent
// ---------------------------------------------------------------------------------------

function IntentEditor({
  draft,
  ambiguities,
  onChange,
  onAnswer,
}: {
  draft: IntentSpec;
  ambiguities: Ambiguity[];
  onChange: (s: IntentSpec) => void;
  onAnswer: (field: string, answer: string) => void;
}) {
  const set = (patch: Partial<IntentSpec>) => onChange({ ...draft, ...patch });
  const toggleCondition = (c: Condition) => {
    const has = draft.allowedConditions.includes(c);
    const next = has
      ? draft.allowedConditions.filter((x) => x !== c)
      : [...draft.allowedConditions, c];
    if (next.length) set({ allowedConditions: next });
  };
  const open = ambiguities.filter((a) => !a.resolvedWith && a.field !== "maxTotal");
  return (
    <Card title="Intent playback" action={<Pill tone="brand">edit before signing</Pill>}>
      <ul className="space-y-1.5 text-sm">
        {specSentences(draft).map((s) => (
          <li key={s.field} className="flex gap-2">
            <span className="text-brand">•</span>
            {s.text}
          </li>
        ))}
      </ul>
      <div className="mt-4 grid gap-3 border-t border-line pt-4 text-sm sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Most you'll pay, all-in (USD)</span>
          <input
            inputMode="decimal"
            className={cx(
              "rounded-lg border bg-transparent px-3 py-1.5 font-mono",
              Number(draft.maxTotal.value) > 0 ? "border-line" : "border-void",
            )}
            value={draft.maxTotal.value === "0.00" ? "" : draft.maxTotal.value}
            placeholder="required"
            onChange={(e) => {
              const v = e.target.value.replace(/[^\d.]/g, "");
              if (/^\d*(\.\d{0,2})?$/.test(v))
                set({ maxTotal: { currency: "USD", value: v || "0.00" } });
            }}
            onBlur={() => {
              const n = Number(draft.maxTotal.value);
              set({
                maxTotal: { currency: "USD", value: Number.isFinite(n) ? n.toFixed(2) : "0.00" },
              });
              if (n > 0) onAnswer("maxTotal", n.toFixed(2));
            }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Product</span>
          <input
            className="rounded-lg border border-line bg-transparent px-3 py-1.5"
            value={draft.category}
            onChange={(e) => set({ category: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Must have (comma separated)</span>
          <input
            className="rounded-lg border border-line bg-transparent px-3 py-1.5"
            value={draft.mustHave.join(", ")}
            onChange={(e) =>
              set({
                mustHave: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Quantity</span>
          <input
            type="number"
            min={1}
            className="rounded-lg border border-line bg-transparent px-3 py-1.5"
            value={draft.quantity}
            onChange={(e) => set({ quantity: Math.max(1, Number(e.target.value) || 1) })}
          />
        </label>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.oneTimeOnly}
              onChange={(e) => set({ oneTimeOnly: e.target.checked })}
            />{" "}
            One-time only
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.allowAddOns}
              onChange={(e) => set({ allowAddOns: e.target.checked })}
            />{" "}
            Allow add-ons
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted">Condition:</span>
          {Condition.options.map((c) => (
            <label key={c} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={draft.allowedConditions.includes(c)}
                onChange={() => toggleCondition(c)}
              />{" "}
              {c}
            </label>
          ))}
        </div>
      </div>
      {(open.length > 0 || ambiguities.some((a) => a.resolvedWith)) && (
        <div className="mt-4 space-y-2 border-t border-line pt-4 text-sm">
          {ambiguities.map((a) => (
            <div key={a.field} className="flex flex-col gap-1">
              <span>
                {a.question}{" "}
                {a.resolvedWith && <span className="text-xs text-muted">({a.resolvedWith})</span>}
              </span>
              {!a.resolvedWith && a.field !== "maxTotal" && (
                <input
                  className="rounded-lg border border-line bg-transparent px-3 py-1.5"
                  placeholder="Your answer"
                  onBlur={(e) => e.target.value && onAnswer(a.field, e.target.value)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function MandateCard({ signed, spec }: { signed: SignIntentResponse; spec: IntentSpec }) {
  const [open, setOpen] = useState(false);
  return (
    <Card title="Signed mandate" action={<Pill tone="good">signed · Ed25519</Pill>}>
      <p className="text-sm">{signed.mandate.naturalLanguageDescription}</p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted">
        <div>
          <dt>Intent</dt>
          <dd className="font-mono text-ink">{signed.intentId}</dd>
        </div>
        <div>
          <dt>Spec hash</dt>
          <dd className="font-mono text-ink">{shortHash(signed.mandate.specHash)}</dd>
        </div>
      </dl>
      <button className="mt-3 text-xs text-brand" onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Show"} JWS
      </button>
      {open && (
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-panel p-2 font-mono text-[11px]">
          {signed.jws}
        </pre>
      )}
      <p className="sr-only">{JSON.stringify(spec.maxTotal)}</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------
// Step 2: agent log
// ---------------------------------------------------------------------------------------

function stepLabel(s: AgentStep): string | null {
  const input = (s.input ?? {}) as Record<string, unknown>;
  if (s.type === "tool_call") {
    if (s.tool === "search_catalog") return `Searching “${String(input.q ?? "")}”`;
    if (s.tool === "get_product_page") return `Opened ${String(input.sku)}`;
    if (s.tool === "add_to_cart") return `Added ${String(input.sku)} to the cart`;
    if (s.tool === "view_cart") return "Checked the cart";
    if (s.tool === "checkout") return "Checking out with PayPal…";
  }
  if (s.type === "tool_result" && s.output && typeof s.output === "object" && "error" in s.output)
    return `  ↳ ${String((s.output as { error: unknown }).error)}`;
  if (s.type === "tool_result" && s.tool === "checkout")
    return `  ↳ Order ${String((s.output as { orderId?: string }).orderId ?? "")} created`;
  if (s.type === "text") return `“${String(s.output).slice(0, 220)}”`;
  return null;
}

function AgentLog({ steps }: { steps: AgentStep[] }) {
  const lines = steps.map((s) => ({ s, label: stepLabel(s) })).filter((x) => x.label);
  return (
    <ol className="max-h-72 space-y-1 overflow-auto rounded-xl bg-panel p-3 font-mono text-xs">
      {lines.map(({ s, label }) => (
        <li key={s.i} className={cx("rise-in", s.type === "text" && "text-muted")}>
          {label}
        </li>
      ))}
    </ol>
  );
}

async function streamAgent(
  body: object,
  onStep: (s: AgentStep) => void,
): Promise<{ trace: AgentTrace; checkout?: Checkout; summary?: string }> {
  const res = await fetch("/api/agent/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(j.error?.message ?? `Agent failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (!event || !data) continue;
      const payload: unknown = JSON.parse(data);
      if (event === "step") onStep(payload as AgentStep);
      if (event === "result")
        return payload as { trace: AgentTrace; checkout?: Checkout; summary?: string };
      if (event === "error") throw new Error((payload as { message: string }).message);
    }
  }
  throw new Error("Agent stream ended without a result");
}

// ---------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------

export function ShopClient() {
  const [text, setText] = useState(EXAMPLES[0]!);
  const [draft, setDraft] = useState<IntentSpec | null>(null);
  const [ambiguities, setAmbiguities] = useState<Ambiguity[]>([]);
  const [signed, setSigned] = useState<SignIntentResponse | null>(null);
  const [config, setConfig] = useState<Config>({ models: [], scenarios: [] });
  const [model, setModel] = useState("");
  const [scenario, setScenario] = useState("");
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [noPurchase, setNoPurchase] = useState(false);
  const [order, setOrder] = useState<NormalizedOrder | null>(null);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replay, setReplay] = useState(false);
  const { live, patch } = useLiveOrder(replay ? undefined : checkout?.orderId);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json() as Promise<Config>)
      .then((c) => {
        setConfig(c);
        setModel(c.models.find((m) => m.available)?.id ?? c.models[0]?.id ?? "");
      })
      .catch(() => {});
    return () => timers.current.forEach((t) => clearTimeout(t));
  }, []);

  // Polling fallback: if sockets are blocked, the verification still lands.
  useEffect(() => {
    if (!verificationId || replay) return;
    let stop = false;
    const tick = async () => {
      try {
        const v = await poi.getVerification(verificationId);
        if (!stop) setVerification(v);
        if (v.status === "DONE" || v.status === "ERROR") return;
      } catch {
        // keep trying
      }
      if (!stop) timers.current.push(window.setTimeout(tick, 2000));
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [verificationId, replay, live.verdict, live.settled]);

  const checks: CheckResult[] = live.checks.length ? live.checks : (verification?.checks ?? []);
  const verdict =
    live.verdict?.verdict ?? (verification?.status === "DONE" ? verification.verdict : undefined);
  const summary = live.verdict?.summary ?? verification?.summary ?? "";
  const settlement = live.settled?.action ?? verification?.settlement?.action ?? null;
  const intentSigned = !!signed;

  const run = async <T,>(label: string, fn: () => Promise<T>) => {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(msg(err));
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const compile = () =>
    run("compile", async () => {
      const r = await poi.compileIntent(text);
      setDraft(r.draft);
      setAmbiguities(r.ambiguities);
      setSigned(null);
    });

  const answer = (field: string, value: string) =>
    setAmbiguities((as) => as.map((a) => (a.field === field ? { ...a, resolvedWith: value } : a)));

  const sign = () =>
    run("sign", async () => {
      if (!draft) return;
      const spec = IntentSpec.parse({ ...draft, ambiguities });
      setSigned(await poi.signIntent(spec));
    });

  const runAgent = () =>
    run("agent", async () => {
      if (!signed || !draft) return;
      setSteps([]);
      setCheckout(null);
      setOrder(null);
      setNoPurchase(false);
      const result = await streamAgent(
        { userText: draft.rawText, model, ...(scenario ? { scenario } : {}) },
        (s) => setSteps((xs) => [...xs, s]),
      );
      if (!result.checkout) {
        setNoPurchase(true);
        return;
      }
      await poi.attachOrder(result.checkout.orderId, {
        intentId: signed.intentId,
        agentTrace: result.trace,
        mode: "live",
      });
      const preview = await fetch("/api/checkout-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: result.trace.chosenSkus.map((sku) => ({ sku, qty: 1 })) }),
      }).then((r) => r.json() as Promise<{ purchaseUnit: Parameters<typeof previewToOrder>[1] }>);
      setOrder(previewToOrder(result.checkout.orderId, preview.purchaseUnit));
      setCheckout(result.checkout);
    });

  const authorize = () =>
    run("authorize", async () => {
      if (!checkout) return;
      const r = await poi.authorizeOrder(checkout.orderId);
      setVerificationId(r.verificationId);
    });

  const decide = (decision: "CAPTURE" | "VOID") =>
    run("decide", async () => {
      const id = verificationId ?? live.verificationId;
      if (!id) return;
      setVerification(await poi.decide(id, decision));
      patch({ settled: undefined });
    });

  /** Plays a recorded poisoned run (no APIs needed) for when the network is slow on camera. */
  const startReplay = () => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
    setReplay(true);
    setError(null);
    setText(demoSpec.rawText);
    setDraft(demoSpec);
    setAmbiguities([]);
    setSigned({ intentId: demoMandate.intentId, mandate: demoMandate, jws: DEMO_JWS });
    setSteps([]);
    setOrder(null);
    setCheckout(null);
    setVerification(null);
    setVerificationId(null);
    patch({ checks: [], verdict: undefined, settled: undefined, stages: [] });
    let t = 300;
    const at = (ms: number, fn: () => void) =>
      timers.current.push(window.setTimeout(fn, (t += ms)));
    for (const s of poisonedTrace.steps) at(450, () => setSteps((xs) => [...xs, s]));
    at(600, () => {
      setOrder(voidOrder);
      setCheckout({
        orderId: voidOrder.orderId,
        merchantId: voidOrder.merchantId,
        approveUrl: "#",
      });
    });
    at(1800, () => setVerificationId("demo"));
    for (const c of voidChecks)
      at(650, () => patch({ checks: [...voidChecks.slice(0, voidChecks.indexOf(c) + 1)] }));
    at(700, () =>
      patch({
        verdict: {
          verificationId: "demo",
          orderId: voidOrder.orderId,
          verdict: "VOID",
          summary: VOID_SUMMARY,
        },
      }),
    );
    at(900, () =>
      patch({ settled: { orderId: voidOrder.orderId, action: "VOIDED", paypalStatus: "VOIDED" } }),
    );
  };

  const scenarioOptions = useMemo(() => config.scenarios, [config.scenarios]);

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
      <div className="space-y-10">
        <Step n={1} title="Tell POI what you mean" active={!intentSigned} done={intentSigned}>
          <div className="space-y-3">
            <textarea
              className="h-20 w-full rounded-xl border border-line bg-white p-3 text-sm dark:bg-zinc-900"
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={intentSigned}
            />
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((e) => (
                <button
                  key={e}
                  className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-ink"
                  onClick={() => setText(e)}
                  disabled={intentSigned}
                >
                  {e.split(",")[0]}
                </button>
              ))}
            </div>
            {!intentSigned && (
              <Button onClick={compile} disabled={!!busy || !text.trim()}>
                {busy === "compile" && <Spinner />} Compile intent
              </Button>
            )}
            {draft && !intentSigned && (
              <>
                <IntentEditor
                  draft={draft}
                  ambiguities={ambiguities}
                  onChange={setDraft}
                  onAnswer={answer}
                />
                <Button onClick={sign} disabled={!!busy || Number(draft.maxTotal.value) <= 0}>
                  {busy === "sign" && <Spinner />} Sign and delegate
                </Button>
              </>
            )}
            {signed && draft && <MandateCard signed={signed} spec={draft} />}
          </div>
        </Step>

        <Step n={2} title="Let the agent shop" active={intentSigned && !checkout} done={!!checkout}>
          <div className="space-y-3">
            {!checkout && !replay && (
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-xs text-muted">
                  Agent model
                  <select
                    className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm text-ink dark:bg-zinc-900"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {config.models.map((m) => (
                      <option key={m.id} value={m.id} disabled={!m.available}>
                        {m.id}
                        {m.available ? "" : " (no key)"}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted">
                  Bazaar scenario
                  <select
                    className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm text-ink dark:bg-zinc-900"
                    value={scenario}
                    onChange={(e) => setScenario(e.target.value)}
                  >
                    <option value="">Whole catalog</option>
                    {scenarioOptions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.id} ({s.family})
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  onClick={runAgent}
                  disabled={!!busy || !config.models.find((m) => m.id === model)?.available}
                >
                  {busy === "agent" && <Spinner />} Run agent
                </Button>
              </div>
            )}
            {steps.length > 0 && <AgentLog steps={steps} />}
            {noPurchase && (
              <p className="text-sm text-muted">The agent finished without checking out.</p>
            )}
          </div>
        </Step>

        <Step
          n={3}
          title="Approve with PayPal"
          active={!!checkout && !verificationId}
          done={!!verificationId}
        >
          {order && (
            <div className="space-y-3">
              <OrderLines
                order={order}
                checks={checks}
                title="What the merchant put in the PayPal order"
              />
              {!verificationId && (
                <div className="rounded-xl border border-ask/50 bg-ask/10 p-4 text-sm">
                  <p className="font-semibold">Without POI, this captures now:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {order.lines.map((l, i) => (
                      <li key={i}>
                        {l.name} -- ${l.unitAmount.value}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1">
                    Total {order.total.value} USD. With POI, PayPal only places a hold until the
                    order is verified.
                  </p>
                </div>
              )}
              {!verificationId && checkout && !replay && (
                <div className="max-w-sm">
                  {PAYPAL_CLIENT_ID ? (
                    <PayPalScriptProvider
                      options={{ clientId: PAYPAL_CLIENT_ID, intent: "authorize", currency: "USD" }}
                    >
                      <PayPalButtons
                        style={{ layout: "vertical", label: "pay" }}
                        createOrder={async () => checkout.orderId}
                        onApprove={async () => void (await authorize())}
                      />
                    </PayPalScriptProvider>
                  ) : (
                    <div className="space-y-2 text-sm">
                      <a
                        className="text-brand underline"
                        href={checkout.approveUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open the PayPal approval page
                      </a>
                      <p className="text-xs text-muted">
                        Sign in with the sandbox buyer, approve, then come back.
                      </p>
                      <Button onClick={authorize} disabled={!!busy}>
                        {busy === "authorize" && <Spinner />} I approved it -- verify
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </Step>
        <ErrorNote error={error} />
      </div>

      <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <Card
          title="Verifier"
          action={
            <span className="flex items-center gap-2 text-xs text-muted">
              {replay ? (
                <Pill tone="brand">replay</Pill>
              ) : (
                checkout && (
                  <Pill tone={live.connected ? "good" : "neutral"}>
                    {live.connected ? "live" : "polling"}
                  </Pill>
                )
              )}
            </span>
          }
        >
          {verificationId || replay ? (
            <CheckList checks={checks} />
          ) : (
            <p className="text-sm text-muted">Checks stream in here once the hold is placed.</p>
          )}
        </Card>
        {verdict && (
          <VerdictCard verdict={verdict} summary={summary} settlement={settlement}>
            {verdict === "ASK_HUMAN" && settlement === "PENDING_HUMAN" && !replay && (
              <div className="mt-4 flex gap-2">
                <Button variant="success" onClick={() => decide("CAPTURE")} disabled={!!busy}>
                  Approve and pay
                </Button>
                <Button variant="danger" onClick={() => decide("VOID")} disabled={!!busy}>
                  Reject
                </Button>
              </div>
            )}
            {checkout && !replay && (
              <Link
                className="mt-4 inline-block text-sm text-brand underline"
                href={`/verify/${checkout.orderId}`}
              >
                See the signed evidence
              </Link>
            )}
          </VerdictCard>
        )}
        <Button variant="ghost" onClick={startReplay} className="w-full">
          Replay a recorded run
        </Button>
      </aside>
    </div>
  );
}
