"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { DefenderInfo } from "@poi/shared";
import { poi } from "@/lib/config";

/**
 * The status line along the top: the mark, whether the firewall is armed (the API answers) and which
 * defender version is live. Polls quietly; an unreachable API just reads "offline".
 */
export function MonitorStrip() {
  const [defender, setDefender] = useState<DefenderInfo | null>(null);
  const [up, setUp] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      poi
        .getDefender()
        .then((d) => {
          if (!alive) return;
          setDefender(d);
          setUp(true);
        })
        .catch(() => alive && setUp(false));
    void tick();
    const id = setInterval(tick, 20_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <header
      data-print="hidden"
      className="sticky top-0 z-30 border-b border-ice/10 bg-canvas/70 backdrop-blur-md"
    >
      <div className="mx-auto flex h-11 max-w-[1400px] items-center gap-4 px-4 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="relative grid h-6 w-6 place-items-center">
            <span className="absolute inset-0 rounded-full border border-ice/70 shadow-[0_0_14px_-2px_#9be7ff]" />
            <span className="h-1.5 w-1.5 rounded-full bg-ice" />
          </span>
          <span className="font-mono text-[11px] tracking-[0.3em] text-ink">PROOFOFINTENT</span>
        </Link>
        <span className="hidden h-4 w-px bg-ice/15 sm:block" />
        <span className="hidden items-center gap-2 font-mono text-[11px] tracking-[0.18em] text-muted sm:flex">
          <span
            className={
              up === false
                ? "h-1.5 w-1.5 rounded-full bg-void"
                : "motion-safe-only h-1.5 w-1.5 animate-pulse-edge rounded-full bg-capture shadow-[0_0_8px_#7ce8c9]"
            }
          />
          {up === false ? "API OFFLINE" : "FIREWALL ARMED"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {defender && (
            <span className="chip hidden !py-1 font-mono !text-[11px] tracking-[0.12em] sm:inline-flex">
              DEFENDER v{defender.version} · {defender.activeAntibodies} ANTIBODIES
            </span>
          )}
          <span className="chip !border-ask/40 !bg-ask/10 !py-1 font-mono !text-[11px] tracking-[0.12em] !text-ask">
            SANDBOX
          </span>
        </div>
      </div>
    </header>
  );
}
