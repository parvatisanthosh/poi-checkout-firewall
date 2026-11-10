import {
  formatMoney,
  fromCents,
  toCents,
  type CheckResult,
  type NormalizedOrder,
  type SettlementAction,
  type Verdict,
} from "@poi/shared";
import { Card, cx, outcomeTone, Pill, SETTLEMENT_TEXT, StageIcon, verdictTone } from "./ui";

/** Order line indexes a check points at ("/lines/1/name" -> 1). */
export function flaggedLines(checks: CheckResult[]): Set<number> {
  const out = new Set<number>();
  for (const c of checks) {
    if (c.outcome === "pass" || !c.field) continue;
    const m = /^\/lines\/(\d+)/.exec(c.field);
    if (m) out.add(Number(m[1]));
  }
  return out;
}

export function flaggedFields(checks: CheckResult[]): Set<string> {
  return new Set(
    checks.filter((c) => c.outcome !== "pass" && c.field).map((c) => c.field!.split("/")[1] ?? ""),
  );
}

export function CheckRow({ check }: { check: CheckResult }) {
  return (
    <li className="rise-in flex items-start gap-3 border-b border-line py-2 last:border-0">
      <StageIcon stage={check.stage} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs">{check.check}</span>
          <Pill tone={outcomeTone(check.outcome)}>
            {check.outcome === "pass" ? "pass" : `${check.outcome} · ${check.severity}`}
          </Pill>
          {check.confidence !== undefined && (
            <span className="text-[11px] text-muted">{Math.round(check.confidence * 100)}%</span>
          )}
        </div>
        <p className="mt-0.5 text-sm text-muted">{check.reason}</p>
      </div>
      <span className="shrink-0 font-mono text-[11px] text-muted">
        {check.latencyMs < 1 ? "<1" : Math.round(check.latencyMs)} ms
      </span>
    </li>
  );
}

const STAGES: Array<CheckResult["stage"]> = ["deterministic", "rag", "semantic", "shadow"];

export function CheckList({
  checks,
  grouped = false,
}: {
  checks: CheckResult[];
  grouped?: boolean;
}) {
  if (!checks.length) return <p className="text-sm text-muted">Waiting for checks…</p>;
  if (!grouped) {
    return (
      <ul>
        {checks.map((c, i) => (
          <CheckRow key={`${c.check}-${i}`} check={c} />
        ))}
      </ul>
    );
  }
  return (
    <div className="space-y-4">
      {STAGES.map((stage) => {
        const items = checks.filter((c) => c.stage === stage);
        if (!items.length) return null;
        return (
          <div key={stage}>
            <h3 className="eyebrow mb-2 !text-[10px]">{stage}</h3>
            <ul>
              {items.map((c, i) => (
                <CheckRow key={`${c.check}-${i}`} check={c} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export function OrderLines({
  order,
  checks = [],
  title = "Order",
}: {
  order: NormalizedOrder;
  checks?: CheckResult[];
  title?: string;
}) {
  const flagged = flaggedLines(checks);
  const fields = flaggedFields(checks);
  const b = order.breakdown;
  const extra: Array<[string, string, string | undefined]> = [
    ["Items", "itemTotal", formatMoney(b.itemTotal)],
    ["Shipping", "shipping", b.shipping && formatMoney(b.shipping)],
    ["Handling", "handling", b.handling && formatMoney(b.handling)],
    ["Tax", "taxTotal", b.taxTotal && formatMoney(b.taxTotal)],
    ["Insurance", "insurance", b.insurance && formatMoney(b.insurance)],
    ["Discount", "discount", b.discount && `-${formatMoney(b.discount)}`],
  ];
  return (
    <Card
      title={title}
      action={
        <span
          className={cx(
            "text-xs",
            fields.has("merchantDisplayName") || fields.has("merchantId")
              ? "font-semibold text-void"
              : "text-muted",
          )}
        >
          {order.merchantDisplayName}
        </span>
      }
    >
      <ul className="divide-y divide-line">
        {order.lines.map((l, i) => (
          <li
            key={i}
            className={cx(
              "flex items-start justify-between gap-4 py-2",
              flagged.has(i) && "-mx-2 rounded-lg bg-void/10 px-2",
            )}
          >
            <div className="min-w-0">
              <p className={cx("text-sm", flagged.has(i) && "font-medium text-void")}>
                {l.quantity > 1 && <span className="mr-1 text-muted">{l.quantity} ×</span>}
                {l.name}
              </p>
              {l.description && <p className="text-xs text-muted">{l.description}</p>}
              {l.category === "DIGITAL_GOODS" && <Pill tone="warn">digital</Pill>}
            </div>
            <span className="shrink-0 font-mono text-sm">
              {formatMoney(fromCents(toCents(l.unitAmount) * l.quantity, l.unitAmount.currency))}
            </span>
          </li>
        ))}
      </ul>
      <dl className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
        {extra
          .filter(([, , v]) => v && v !== "$0.00")
          .map(([label, key, v]) => (
            <div
              key={key}
              className={cx(
                "flex justify-between",
                fields.has(`breakdown`) &&
                  (key === "handling" || key === "insurance") &&
                  "text-void",
              )}
            >
              <dt className="text-muted">{label}</dt>
              <dd className="font-mono">{v}</dd>
            </div>
          ))}
        <div
          className={cx("flex justify-between font-semibold", fields.has("total") && "text-void")}
        >
          <dt>Total</dt>
          <dd className="font-mono">{formatMoney(order.total)}</dd>
        </div>
      </dl>
    </Card>
  );
}

export function VerdictCard({
  verdict,
  summary,
  settlement,
  children,
}: {
  verdict: Verdict;
  summary: string;
  settlement?: SettlementAction | null;
  children?: React.ReactNode;
}) {
  const tone = verdictTone(verdict);
  const text = tone === "good" ? "mint-text" : tone === "bad" ? "danger-text" : "amber-text";
  const dataTone = tone === "good" ? "capture" : tone === "bad" ? "void" : "ask";
  return (
    <div
      data-tone={dataTone}
      className="vault-panel hud-corners rise-in relative overflow-hidden rounded-2xl p-6 sm:p-7"
    >
      <div className="scanline" />
      <p className="eyebrow">POI verdict</p>
      <p className={cx("display mt-3 text-5xl uppercase sm:text-6xl", text)}>
        {verdict === "CAPTURE" ? "Captured" : verdict === "VOID" ? "Voided" : "Ask you"}
      </p>
      <p className="mt-4 text-base leading-relaxed text-ink">{summary}</p>
      {settlement && (
        <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
          {SETTLEMENT_TEXT[settlement]}
        </p>
      )}
      {children}
    </div>
  );
}
