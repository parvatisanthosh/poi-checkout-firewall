import type { ReactNode } from "react";
import type { CheckResult, SettlementAction, Verdict } from "@poi/shared";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function Card({
  children,
  className,
  title,
  action,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section
      className={cx(
        "rounded-2xl border border-line bg-white p-5 shadow-sm dark:bg-zinc-900",
        className,
      )}
    >
      {(title || action) && (
        <header className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  type = "button",
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost" | "danger" | "success";
  type?: "button" | "submit";
  className?: string;
}) {
  const styles = {
    primary: "bg-brand text-white hover:brightness-110",
    ghost: "border border-line bg-transparent hover:bg-brand-soft",
    danger: "bg-void text-white hover:brightness-110",
    success: "bg-capture text-white hover:brightness-110",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        styles,
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "brand";
}) {
  const styles = {
    neutral: "bg-line/60 text-muted",
    good: "bg-capture/15 text-capture",
    warn: "bg-ask/20 text-ask",
    bad: "bg-void/15 text-void",
    brand: "bg-brand-soft text-brand",
  }[tone];
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        styles,
      )}
    >
      {children}
    </span>
  );
}

export const verdictTone = (v?: Verdict | null) =>
  v === "CAPTURE" ? "good" : v === "VOID" ? "bad" : v === "ASK_HUMAN" ? "warn" : "neutral";
export const outcomeTone = (o: CheckResult["outcome"]) =>
  o === "pass" ? "good" : o === "warn" ? "warn" : "bad";

export function VerdictBadge({ verdict }: { verdict?: Verdict | null }) {
  return <Pill tone={verdictTone(verdict)}>{verdict ? verdict.replace("_", " ") : "running"}</Pill>;
}

export const SETTLEMENT_TEXT: Record<SettlementAction, string> = {
  CAPTURED: "Payment captured on PayPal.",
  VOIDED: "Authorization voided on PayPal -- no money moved.",
  PENDING_HUMAN: "Hold placed. Waiting for your decision.",
  NONE: "Dry run -- nothing settled.",
};

export function StageIcon({ stage }: { stage: CheckResult["stage"] }) {
  const label = { deterministic: "Rules", semantic: "Judge", rag: "Terms", shadow: "Shadow" }[
    stage
  ];
  return (
    <span className="inline-flex w-16 shrink-0 justify-center rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-brand">
      {label}
    </span>
  );
}

export function Spinner() {
  return (
    <span
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent"
      aria-hidden
    />
  );
}

export function ErrorNote({ error }: { error?: string | null }) {
  if (!error) return null;
  return <p className="mt-3 rounded-lg bg-void/10 px-3 py-2 text-sm text-void">{error}</p>;
}
