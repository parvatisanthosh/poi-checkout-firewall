"use client";

import { useEffect, useRef } from "react";
import type { CheckResult, Verdict } from "@poi/shared";
import { haltNow, passNow, setStage, toneOfVerdict, type StageMode, type StageSlab } from "./store";

/** A slab for an order: tone from the verdict, links broken and rows reddened by the checks that failed. */
export function slabFor(
  id: string,
  label: string,
  verdict: Verdict | null | undefined,
  checks: CheckResult[] = [],
): StageSlab {
  const failing = checks.filter((c) => c.outcome !== "pass");
  const fails = checks.filter((c) => c.outcome === "fail").length;
  const tone = toneOfVerdict(verdict);
  const base = verdict === "VOID" ? 0.55 : verdict === "ASK_HUMAN" ? 0.3 : 0;
  return {
    id,
    label: label.slice(0, 14).toUpperCase(),
    status: verdict ? verdict.replace("_", " ").toLowerCase() : "verifying",
    tone,
    mismatch: Math.min(0.95, base + fails * 0.1 + (failing.length - fails) * 0.04),
    flags: Math.min(5, fails),
  };
}

/**
 * Put one order on stage: while it has no verdict the page keeps its own scene (`idle`); once it has one the
 * order comes forward and splits by its mismatch -- a VOID fires the red shock, a CAPTURE the mint pulse.
 */
export function useStageVerdict(
  order: { id: string; label: string } | null,
  verdict: Verdict | null | undefined,
  checks: CheckResult[],
  idle: StageMode,
) {
  const fired = useRef<string | null>(null);
  const failing = checks.filter((c) => c.outcome !== "pass").length;
  useEffect(() => {
    if (!order || !verdict) {
      setStage({ mode: idle, focus: null });
      return;
    }
    setStage({
      slabs: [slabFor(order.id, order.label, verdict, checks)],
      focus: order.id,
      mode: "focus",
    });
    const key = `${order.id}:${verdict}`;
    if (fired.current === key) return;
    fired.current = key;
    const t = setTimeout(
      () => (verdict === "VOID" ? haltNow() : verdict === "CAPTURE" && passNow()),
      700,
    );
    return () => clearTimeout(t);
    // checks are summarised by `failing`; the slab only needs rebuilding when that changes
  }, [order?.id, order?.label, verdict, failing, idle]);
}
