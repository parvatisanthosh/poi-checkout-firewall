"use client";

import { useEffect, useState } from "react";
import { PoiApiError, type VerifyRecordResponse } from "@poi/shared";
import { Button, Card, ErrorNote, Pill, Spinner } from "@/components/ui";
import { CheckList, OrderLines, VerdictCard } from "@/components/verification";
import { POI_API_URL, poi } from "@/lib/config";
import { shortHash, specSentences } from "@/lib/spec";
import { useStageVerdict } from "@/components/stage/hooks";

export function VerifyClient({ orderId }: { orderId: string }) {
  const [rec, setRec] = useState<VerifyRecordResponse | null>(null);
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

function Record({ rec, orderId }: { rec: VerifyRecordResponse; orderId: string }) {
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

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        {v?.verdict && (
          <VerdictCard
            verdict={v.verdict}
            summary={v.summary ?? ""}
            settlement={v.settlement?.action ?? null}
          />
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
