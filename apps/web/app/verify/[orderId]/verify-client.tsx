"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PoiApiError, type VerifyRecordResponseL2 } from "@poi/shared";
import { Button, Card, cx, ErrorNote, Pill, Spinner } from "@/components/ui";
import { CheckList, OrderLines, VerdictCard } from "@/components/verification";
import { POI_API_URL, poi } from "@/lib/config";
import { shortHash, specSentences } from "@/lib/spec";
import { useStageVerdict } from "@/components/stage/hooks";

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
  return <Record rec={rec} orderId={orderId} />;
}

function Record({ rec, orderId }: { rec: VerifyRecordResponseL2; orderId: string }) {
  const v = rec.verification;
  // the order on stage: forward, split by what failed; a VOID replays the shock
  useStageVerdict(
    { id: orderId, label: rec.order?.merchantDisplayName ?? orderId },
    v?.verdict,
    v?.checks ?? [],
    "focus",
  );

  const download = () => {
    const blob = new Blob([JSON.stringify(rec, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `poi-evidence-${orderId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const ev = rec.evidence;
  const cal = rec.calibration;
  const risk = rec.merchantRisk;
  const cf = rec.counterfactual;
  const matches = rec.immuneMatches ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        {/* Layer 2: the calibration the verdict was certified under, the seller's risk, the defender */}
        {(cal || risk || rec.defenderVersion !== undefined) && (
          <div className="flex flex-wrap items-center gap-2">
            {cal && (
              <Link
                href="/calibration"
                className="chip !py-1 font-mono !text-[11px] tracking-[0.08em] transition hover:border-ice/50 hover:bg-ice/10"
                title={`Calibration ${cal.calibrationId}: n=${cal.n}, lambdaAsk=${cal.lambdaAsk}, lambdaVoid=${cal.lambdaVoid}`}
              >
                <span className="text-white">Certified at &alpha; = {cal.alpha}</span>
                <span className="text-faint">
                  n={cal.n} ·{" "}
                  {cal.calibrationId.length > 16
                    ? `${cal.calibrationId.slice(0, 16)}…`
                    : cal.calibrationId}
                </span>
              </Link>
            )}
            {risk && (
              <span
                title={`Orders: ${risk.orders}, voids: ${risk.voids}, reports: ${risk.reports}`}
              >
                <Pill tone={risk.risk >= 0.35 ? "bad" : "good"}>
                  <span
                    className={cx(
                      "h-1.5 w-1.5 rounded-full",
                      risk.risk >= 0.35 ? "bg-void shadow-[0_0_8px_#ff2d55]" : "bg-capture",
                    )}
                  />
                  seller risk {(risk.risk * 100).toFixed(0)}%
                  {risk.risk >= 0.35 ? " · elevated" : " · normal"}
                </Pill>
              </span>
            )}
            {rec.defenderVersion !== undefined && (
              <Pill tone="neutral">defender v{rec.defenderVersion}</Pill>
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

        {/* What capturing this order would have cost over a year, beyond what was asked */}
        {cf && (
          <Card
            title="Counterfactual · 12 months"
            tone="ask"
            action={<Pill tone="warn">avoided</Pill>}
          >
            <p className="display amber-text text-4xl sm:text-5xl">
              {cf.annualExtraUsd !== null && cf.annualExtraUsd !== undefined
                ? `$${cf.annualExtraUsd.toFixed(2)}`
                : "Unknown"}
            </p>
            <p className="mt-2 text-sm text-muted">
              {cf.annualExtraUsd !== null && cf.annualExtraUsd !== undefined
                ? "What capturing this order would have cost over 12 months beyond what was asked."
                : "Capturing it would have added recurring charges whose amount isn't stated -- never guessed."}
            </p>
            {cf.items.length > 0 && (
              <ul className="mt-4 divide-y divide-line border-t border-line">
                {cf.items.map((item, idx) => {
                  const monthly = item.monthlyUsd;
                  const oneOff = item.oneOffUsd;
                  return (
                    <li key={idx} className="flex items-center justify-between gap-4 py-2 text-sm">
                      <span className="text-ink">{item.label}</span>
                      <span className="shrink-0 font-mono text-ask">
                        {monthly !== null && monthly !== undefined
                          ? `$${monthly.toFixed(2)}/mo · $${(monthly * 12).toFixed(2)}/yr`
                          : oneOff !== undefined
                            ? `$${oneOff.toFixed(2)} one-off`
                            : "recurring, amount unknown"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        )}

        {/* Learned antibodies this order matched */}
        {matches.length > 0 && (
          <Card
            title="Immune match"
            corners
            action={
              <Link
                href="/immune"
                className="font-mono text-[11px] uppercase tracking-[0.16em] text-ice hover:text-white"
              >
                View in immune &rarr;
              </Link>
            }
          >
            <div className="space-y-3">
              {matches.map((m, i) => {
                const ab = rec.antibodies?.find((a) => a.id === m.antibodyId);
                const similarityPct = Math.round(m.similarity * 100);
                return (
                  <div
                    key={`${m.antibodyId}-${m.kind}-${i}`}
                    className="flex flex-col gap-3 rounded-xl border border-ice/10 bg-canvas/50 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href="/immune"
                          className="font-mono text-xs font-semibold text-ice hover:text-white"
                        >
                          {m.antibodyId}
                        </Link>
                        <Pill tone={m.action === "VOID" ? "bad" : "warn"}>{m.action}</Pill>
                        <Pill tone="neutral">{m.kind}</Pill>
                        {ab?.family && <Pill tone="brand">{ab.family}</Pill>}
                      </div>
                      <p className="text-xs text-muted">
                        Matched by the <span className="font-mono text-ink">{m.kind}</span> detector
                        -- a trick POI learned from an earlier order.
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <span className="font-mono text-2xl font-semibold text-white">
                        {similarityPct}%
                      </span>
                      <p className="eyebrow !text-[9px]">similarity</p>
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
