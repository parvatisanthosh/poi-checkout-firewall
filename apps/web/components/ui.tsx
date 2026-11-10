import type { ReactNode } from "react";
import type { CheckResult, SettlementAction, Verdict } from "@poi/shared";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

type PanelTone = "capture" | "ask" | "void";

/** A slab of frosted glass holding data, lit along its top edge. `title` renders as a mono eyebrow. */
export function Card({
  children,
  className,
  title,
  action,
  tone,
  corners,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  action?: ReactNode;
  tone?: PanelTone;
  corners?: boolean;
}) {
  return (
    <section
      data-tone={tone}
      className={cx("vault-panel rounded-2xl p-5 sm:p-6", corners && "hud-corners", className)}
    >
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="eyebrow">{title}</h2>}
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
    primary: "pill-primary",
    ghost: "pill-ghost",
    danger: "pill-halt",
    success: "pill-mint",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cx("pill-cta", styles, className)}
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
    neutral: "border-ice/15 bg-ice/[0.04] text-muted",
    good: "border-capture/35 bg-capture/10 text-capture",
    warn: "border-ask/40 bg-ask/10 text-ask",
    bad: "border-void/40 bg-void/10 text-void",
    brand: "border-ice/35 bg-ice/10 text-ice",
  }[tone];
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-medium tracking-wide",
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
/** Panel / HUD tone for a verdict. */
export const panelTone = (v?: Verdict | null): PanelTone | undefined =>
  v === "CAPTURE" ? "capture" : v === "VOID" ? "void" : v === "ASK_HUMAN" ? "ask" : undefined;

export function VerdictBadge({ verdict }: { verdict?: Verdict | null }) {
  return (
    <Pill tone={verdictTone(verdict)}>
      <span
        className={cx(
          "h-1.5 w-1.5 rounded-full",
          verdict === "CAPTURE"
            ? "bg-capture"
            : verdict === "VOID"
              ? "bg-void shadow-[0_0_8px_#ff2d55]"
              : verdict === "ASK_HUMAN"
                ? "bg-ask"
                : "motion-safe-only animate-pulse-edge bg-ice",
        )}
      />
      {verdict ? verdict.replace("_", " ") : "running"}
    </Pill>
  );
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
    <span className="inline-flex w-16 shrink-0 justify-center rounded-md border border-ice/20 bg-ice/[0.06] px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ice">
      {label}
    </span>
  );
}

export function Spinner() {
  return (
    <span
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-ice/80 border-r-transparent"
      aria-hidden
    />
  );
}

export function ErrorNote({ error }: { error?: string | null }) {
  if (!error) return null;
  return (
    <p className="mt-3 rounded-xl border border-void/35 bg-void/10 px-3 py-2 text-sm text-rose-200">
      {error}
    </p>
  );
}

/** A page's opening: mono eyebrow, a large ice headline, a lead, and actions. */
export function PageHeader({
  eyebrow,
  title,
  accent,
  lead,
  actions,
  tone = "ice",
  className,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  /** A second headline line in a quieter tone. */
  accent?: ReactNode;
  lead?: ReactNode;
  actions?: ReactNode;
  tone?: "ice" | "danger" | "mint";
  className?: string;
}) {
  const text = tone === "danger" ? "danger-text" : tone === "mint" ? "mint-text" : "ice-text";
  return (
    <header className={cx("relative pb-8 pt-6 sm:pb-12 sm:pt-14", className)}>
      <p className="eyebrow flex items-center gap-3">
        <span className="h-1.5 w-1.5 rounded-full bg-ice shadow-[0_0_10px_#9be7ff]" />
        {eyebrow}
      </p>
      <h1 className={cx("display mt-5 max-w-4xl text-5xl uppercase sm:text-7xl", text)}>
        {title}
        {accent && (
          <span className="block text-muted/70 [-webkit-text-fill-color:currentColor]">
            {accent}
          </span>
        )}
      </h1>
      {lead && (
        <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">{lead}</p>
      )}
      {actions && <div className="mt-8 flex flex-wrap items-center gap-3">{actions}</div>}
    </header>
  );
}

/** A big number with a mono label, for stat rows. */
export function Stat({
  value,
  label,
  sub,
  tone,
}: {
  value: ReactNode;
  label: ReactNode;
  sub?: ReactNode;
  tone?: "ice" | "capture" | "ask" | "void";
}) {
  const color =
    tone === "capture"
      ? "text-capture"
      : tone === "ask"
        ? "text-ask"
        : tone === "void"
          ? "text-void"
          : "text-white";
  return (
    <div className="vault-panel rounded-2xl p-5">
      <p className="eyebrow !text-[10px] !tracking-[0.24em]">{label}</p>
      <p className={cx("mt-3 font-mono text-4xl font-semibold tracking-tight", color)}>{value}</p>
      {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
    </div>
  );
}
