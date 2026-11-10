"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Dna,
  Gauge,
  ScrollText,
  ShoppingCart,
  Store,
  Swords,
  type LucideIcon,
} from "lucide-react";
import { cx } from "@/components/ui";

const LAYER1: Array<[string, string, LucideIcon, string]> = [
  ["/shop", "Demo", ShoppingCart, "Live demo: sign, shop, verify"],
  ["/bazaar", "Bazaar", Store, "The poisoned store, as the agent sees it"],
  ["/ledger", "Ledger", ScrollText, "Every order POI has judged"],
];
const LAYER2: Array<[string, string, LucideIcon, string]> = [
  ["/arena", "Arena", Swords, "Evolved attacks vs POI"],
  ["/immune", "Immune", Dna, "Antibodies POI has learned"],
  ["/calibration", "Gate", Gauge, "Conformal thresholds"],
  ["/bench", "Score", BarChart3, "IntentBench scorecard"],
];

/** Label that rises above a dock item on hover or keyboard focus. */
function DockLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-3 max-w-[60vw] -translate-x-1/2 translate-y-1 truncate whitespace-nowrap rounded-lg border border-ice/20 bg-canvas px-3 py-1.5 text-xs text-ink opacity-0 shadow-xl transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
      {children}
    </span>
  );
}

const itemClass = (active: boolean) =>
  cx(
    "group relative flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-full border px-2 outline-none transition-all duration-200 focus-visible:ring-2 focus-visible:ring-ice/50 sm:h-10 sm:min-w-10 sm:gap-2 sm:px-3",
    active
      ? "border-ice/60 bg-ice/[0.12] text-white shadow-[0_0_24px_-6px_rgba(155,231,255,0.9)]"
      : "border-transparent text-muted hover:border-ice/25 hover:bg-ice/[0.06] hover:text-ink",
  );

function Item({
  href,
  label,
  Icon,
  hint,
}: {
  href: string;
  label: string;
  Icon: LucideIcon;
  hint: string;
}) {
  const pathname = usePathname();
  const active = pathname === href || pathname?.startsWith(`${href}/`);
  return (
    <Link href={href} className={itemClass(!!active)} aria-label={hint}>
      <Icon className="h-4 w-4" />
      <span className="hidden font-mono text-[11px] uppercase tracking-[0.16em] md:inline">
        {label}
      </span>
      <DockLabel>{hint}</DockLabel>
    </Link>
  );
}

/** The console floating at the bottom of every page: home, the Layer 1 demo, and Layer 2. */
export function Dock() {
  return (
    <aside
      data-print="hidden"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-3 select-none"
    >
      <nav className="glass pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-[26px] p-1.5 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.9)] sm:gap-1">
        <Link href="/" className={itemClass(false)} aria-label="ProofOfIntent · the story">
          <span className="h-2 w-2 rounded-full bg-ice shadow-[0_0_12px_#9be7ff]" />
          <DockLabel>ProofOfIntent · the story</DockLabel>
        </Link>
        <span className="mx-0.5 h-5 w-px shrink-0 bg-ice/15 sm:mx-1" />
        {LAYER1.map(([href, label, Icon, hint]) => (
          <Item key={href} href={href} label={label} Icon={Icon} hint={hint} />
        ))}
        <span className="mx-0.5 h-5 w-px shrink-0 bg-ice/15 sm:mx-1" />
        {LAYER2.map(([href, label, Icon, hint]) => (
          <Item key={href} href={href} label={label} Icon={Icon} hint={hint} />
        ))}
      </nav>
    </aside>
  );
}
