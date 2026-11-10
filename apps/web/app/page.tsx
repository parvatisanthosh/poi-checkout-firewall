import Link from "next/link";
import { ArrowRight, Dna, Fingerprint, Gauge, ScanLine, Swords } from "lucide-react";
import type { Rate } from "@poi/shared";
import { HomeStory } from "@/components/home/HomeStory";
import { Reveal, Stagger, StaggerItem } from "@/components/shell/Motion";
import { Stat } from "@/components/ui";
import { readBenchSummary } from "@/lib/server";

export const dynamic = "force-dynamic";

const pct = (r?: Rate | null) => (r && r.p !== null ? `${Math.round(r.p * 100)}%` : "--");

const STEPS = [
  {
    Icon: Fingerprint,
    title: "Sign what you mean",
    body: "POI turns your words into a strict spec -- budget all-in, no subscriptions, new only -- asks about gaps instead of guessing, and you sign it.",
  },
  {
    Icon: ScanLine,
    title: "The agent shops",
    body: "Any agent, any model. The merchant creates a PayPal order with intent AUTHORIZE, so approving it only places a hold.",
  },
  {
    Icon: Gauge,
    title: "POI decides",
    body: "Rules, the fine print, a spotlighted judge and a counterfactual re-run check the real order. CAPTURE, VOID for free, or ask you.",
  },
];

export default function Home() {
  const s = readBenchSummary();
  const full = s?.totals.find((t) => t.family === "all-attacks" && t.config === "full");
  const benign = s?.totals.find((t) => t.family === "benign" && t.config === "full");

  return (
    <HomeStory>
      <div className="space-y-24">
        <Reveal>
          <p className="eyebrow">05 · Every order</p>
          <h2 className="display ice-text mt-5 max-w-4xl text-5xl uppercase sm:text-7xl">
            Checked against
            <span className="block text-muted/70 [-webkit-text-fill-color:currentColor]">
              what you meant.
            </span>
          </h2>
          <div className="mt-10 flex flex-wrap gap-3">
            <Link href="/shop" className="pill-cta pill-primary">
              Run the live demo <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/ledger" className="pill-cta pill-ghost">
              Open the ledger
            </Link>
          </div>
        </Reveal>

        <Stagger className="grid gap-4 md:grid-cols-3">
          {STEPS.map(({ Icon, title, body }, i) => (
            <StaggerItem key={title}>
              <div className="vault-panel h-full rounded-2xl p-6">
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-xl border border-ice/25 bg-ice/[0.06] text-ice">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="font-mono text-[11px] tracking-[0.28em] text-faint">
                    0{i + 1}
                  </span>
                </div>
                <h3 className="mt-5 text-lg font-semibold text-white">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
              </div>
            </StaggerItem>
          ))}
        </Stagger>

        <Reveal>
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="eyebrow">IntentBench-mini</p>
              <h3 className="mt-3 text-2xl font-semibold text-white">What the numbers say</h3>
            </div>
            <Link href="/bench" className="pill-cta pill-ghost !px-4 !py-2">
              Scorecard <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <Stat
              tone="void"
              value={pct(full?.undefendedAsr)}
              label="Attacks paid without POI"
              sub={
                full
                  ? `${full.undefendedAsr.k}/${full.undefendedAsr.n} agent purchases`
                  : "run the benchmark"
              }
            />
            <Stat
              tone="capture"
              value={pct(full?.defendedAsr)}
              label="Attacks paid with POI"
              sub={full ? `${full.defendedAsr.k}/${full.defendedAsr.n}` : ""}
            />
            <Stat
              tone="ice"
              value={pct(benign?.falseVoidRate)}
              label="Good purchases wrongly voided"
              sub={
                benign?.falseVoidRate ? `${benign.falseVoidRate.k}/${benign.falseVoidRate.n}` : ""
              }
            />
          </div>
          <p className="mt-3 text-xs text-faint">{s ? s.note : "No results yet."}</p>
        </Reveal>

        <Reveal>
          <div className="vault-panel hud-corners overflow-hidden rounded-3xl p-8 sm:p-12">
            <div className="scanline" />
            <p className="eyebrow">Layer 2 · POI Immune</p>
            <h3 className="display ice-text mt-5 max-w-3xl text-4xl uppercase sm:text-6xl">
              And it learns.
            </h3>
            <p className="mt-5 max-w-2xl text-muted">
              An attacker model evolves new tricks against POI in an arena. Every trick that gets
              through is minted into a signed antibody -- and only goes live after it matches none
              of 40 honest listings. Thresholds come from data, with a stated bound. Nothing learned
              can ever loosen a verdict.
            </p>
            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              {(
                [
                  ["/arena", Swords, "Arena", "Evolved attacks vs POI"],
                  ["/immune", Dna, "Immune memory", "Antibodies, signed"],
                  ["/calibration", Gauge, "Conformal gate", "Thresholds with a bound"],
                ] as const
              ).map(([href, Icon, title, sub]) => (
                <Link
                  key={href}
                  href={href}
                  className="group flex items-center gap-4 rounded-2xl border border-ice/12 bg-canvas/50 p-4 transition hover:border-ice/40 hover:bg-ice/[0.05]"
                >
                  <Icon className="h-5 w-5 text-ice" />
                  <span className="flex-1">
                    <span className="block text-sm font-semibold text-white">{title}</span>
                    <span className="block text-xs text-muted">{sub}</span>
                  </span>
                  <ArrowRight className="h-4 w-4 text-faint transition group-hover:translate-x-0.5 group-hover:text-ice" />
                </Link>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </HomeStory>
  );
}
