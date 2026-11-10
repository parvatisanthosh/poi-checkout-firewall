"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PoiApiError, type VerifyRecordResponseL2 } from "@poi/shared";
import { Button, Card, cx, ErrorNote, Pill, Spinner } from "@/components/ui";
import { CheckList, OrderLines, VerdictCard } from "@/components/verification";
import { POI_API_URL, poi } from "@/lib/config";
import { shortHash, specSentences } from "@/lib/spec";

export function VerifyClient({ orderId }: { orderId: string }) {
  const [rec, setRec] = useState<VerifyRecordResponseL2 | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    poi
      .getVerifyRecord(orderId)
      .then(setRec)
      .catch((err: unknown) =>
        setError(
          err instanceof PoiApiError && err.status === 404
            ? `No POI record for order ${orderId}.`
            : `Couldn't load the record: ${(err as Error).message}`,
        ),
      );
  }, [orderId]);

  if (error) return <ErrorNote error={error} />;
  if (!rec) return <Spinner />;

  const download = () => {
    const blob = new Blob([JSON.stringify(rec, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `poi-evidence-${orderId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const v = rec.verification;
  const ev = rec.evidence;
  const cal = rec.calibration;
  const risk = rec.merchantRisk;
  const cf = rec.counterfactual;
  const matches = rec.immuneMatches ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        {/* Layer 2 Certified at alpha badge, merchant risk chip, defender version */}
        {(cal || risk || rec.defenderVersion !== undefined) && (
          <div className="flex flex-wrap items-center gap-2.5">
            {cal && (
              <Link
                href="/calibration"
                className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-400 transition-colors hover:bg-sky-500/20"
                title={`Calibration ID: ${cal.calibrationId}, n=${cal.n}, lambdaVoid=${cal.lambdaVoid}`}
              >
                <span className="font-semibold">Certified at &alpha; = {cal.alpha}</span>
                <span className="text-zinc-400">
                  (n={cal.n},{" "}
                  {cal.calibrationId.length > 16
                    ? `${cal.calibrationId.slice(0, 16)}…`
                    : cal.calibrationId}
                  )
                </span>
              </Link>
            )}
            {risk && (
              <span
                className={cx(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
                  risk.risk >= 0.35
                    ? "border-red-500/40 bg-red-500/10 text-red-400"
                    : "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
                )}
                title={`Orders: ${risk.orders}, Voids: ${risk.voids}, Reports: ${risk.reports}`}
              >
                <span
                  className={cx(
                    "h-1.5 w-1.5 rounded-full",
                    risk.risk >= 0.35 ? "bg-red-400" : "bg-emerald-400",
                  )}
                />
                Merchant risk: {(risk.risk * 100).toFixed(0)}%
                {risk.risk >= 0.35 ? " (Elevated)" : " (Normal)"}
              </span>
            )}
            {rec.defenderVersion !== undefined && (
              <span className="rounded-full border border-zinc-700 bg-zinc-800/80 px-2.5 py-1 text-xs font-mono text-zinc-400">
                defender v{rec.defenderVersion}
              </span>
            )}
          </div>
        )}

        {v?.verdict && (
          <VerdictCard
            verdict={v.verdict}
            summary={v.summary ?? ""}
            settlement={v.settlement?.action ?? null}
          />
        )}

        {/* Counterfactual line & breakdown */}
        {cf && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold text-amber-300">
                {cf.annualExtraUsd !== null && cf.annualExtraUsd !== undefined
                  ? `Capturing this would have cost $${cf.annualExtraUsd.toFixed(2)} over 12 months`
                  : "Capturing this would have cost recurring fees (amount unknown) over 12 months"}
              </span>
              <Pill tone="warn">Counterfactual</Pill>
            </div>
            {cf.items && cf.items.length > 0 && (
              <div className="mt-3 border-t border-amber-500/20 pt-2.5">
                <p className="mb-2 text-xs font-medium text-amber-200/80">
                  12-month cost breakdown beyond intent:
                </p>
                <ul className="space-y-1.5 text-xs text-amber-100/90">
                  {cf.items.map((item, idx) => {
                    const monthly = item.monthlyUsd;
                    const oneOff = item.oneOffUsd;
                    return (
                      <li key={idx} className="flex items-center justify-between">
                        <span>• {item.label}</span>
                        <span className="font-mono font-medium">
                          {monthly !== null && monthly !== undefined
                            ? `$${monthly.toFixed(2)}/mo ($${(monthly * 12).toFixed(2)}/yr)`
                            : oneOff !== undefined
                              ? `$${oneOff.toFixed(2)} one-off`
                              : "recurring, amount unknown"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Immune Match Card */}
        {matches.length > 0 && (
          <Card
            title="Immune match"
            action={
              <Link href="/immune" className="text-xs font-medium text-brand hover:underline">
                View in Immune &rarr;
              </Link>
            }
          >
            <div className="space-y-3">
              {matches.map((m, i) => {
                const ab = rec.antibodies?.find((a) => a.id === m.antibodyId);
                const family = ab?.family;
                const similarityPct = Math.round(m.similarity * 100);
                return (
                  <div
                    key={`${m.antibodyId}-${m.kind}-${i}`}
                    className="flex flex-col gap-2 rounded-lg border border-line bg-surface/50 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href="/immune"
                          className="font-mono text-xs font-semibold text-brand hover:underline"
                        >
                          {m.antibodyId}
                        </Link>
                        <Pill tone={m.action === "VOID" ? "bad" : "warn"}>{m.action}</Pill>
                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">
                          kind: {m.kind}
                        </span>
                        {family && (
                          <span className="rounded border border-purple-500/30 bg-purple-900/40 px-1.5 py-0.5 text-[11px] text-purple-300">
                            family: {family}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted">
                        Matched via detector{" "}
                        <span className="font-mono text-foreground">{m.kind}</span> with{" "}
                        <span className="font-semibold text-foreground">{similarityPct}%</span>{" "}
                        similarity
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <span className="font-mono text-base font-bold text-foreground">
                        {similarityPct}%
                      </span>
                      <div className="text-[10px] text-muted">similarity</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        <Card
          title="Signed intent"
          action={
            <Pill tone={rec.signatureValid ? "good" : "bad"}>
              {rec.signatureValid ? "signature valid" : "signature INVALID"}
            </Pill>
          }
        >
          <p className="mb-2 text-sm italic text-muted">“{rec.intent.rawText}”</p>
          <ul className="space-y-1 text-sm">
            {specSentences(rec.intent.spec).map((s) => (
              <li key={s.field}>• {s.text}</li>
            ))}
          </ul>
          <p className="mt-3 font-mono text-xs text-muted">
            spec hash {shortHash(rec.intent.specHash)} · {rec.intent.intentId}
          </p>
        </Card>
        {rec.order && (
          <OrderLines
            order={rec.order}
            checks={v?.checks ?? []}
            title="Order as PayPal reported it"
          />
        )}
        <Card title="Checks">
          {v ? (
            <CheckList checks={v.checks} grouped />
          ) : (
            <p className="text-sm text-muted">No verification yet.</p>
          )}
        </Card>
      </div>
      <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <Card
          title="Evidence"
          action={
            <Pill tone={rec.chainValid ? "good" : "bad"}>
              {rec.chainValid ? "chain valid" : "chain BROKEN"}
            </Pill>
          }
        >
          {ev ? (
            <dl className="space-y-2 text-xs">
              <div>
                <dt className="text-muted">Record</dt>
                <dd className="font-mono">
                  #{ev.seq} · {new Date(ev.createdAt).toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Hash</dt>
                <dd className="break-all font-mono">{ev.hash}</dd>
              </div>
              <div>
                <dt className="text-muted">Previous hash</dt>
                <dd className="break-all font-mono">{ev.prevHash}</dd>
              </div>
              <div>
                <dt className="text-muted">Signing key</dt>
                <dd className="break-all font-mono">
                  {String(rec.publicJwk.kid ?? rec.publicJwk.x)}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted">No evidence record yet.</p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="ghost" onClick={download}>
              Download evidence JSON
            </Button>
            <a
              className="self-center text-xs text-brand underline"
              href={`${POI_API_URL}/.well-known/jwks.json`}
              target="_blank"
              rel="noreferrer"
            >
              Public key (JWKS)
            </a>
          </div>
          <p className="mt-3 text-xs text-muted">
            Each record is RFC 8785-canonical JSON, SHA-256 chained to the previous one and signed
            with Ed25519. Anyone can recompute it from the download.
          </p>
        </Card>
      </aside>
    </div>
  );
}
