import Link from "next/link";
import type { Rate } from "@poi/shared";
import { readBenchSummary } from "@/lib/server";

export const dynamic = "force-dynamic";

const pct = (r?: Rate | null) => (r && r.p !== null ? `${Math.round(r.p * 100)}%` : "--");

export default function Home() {
  const s = readBenchSummary();
  const full = s?.totals.find((t) => t.family === "all-attacks" && t.config === "full");
  const benign = s?.totals.find((t) => t.family === "benign" && t.config === "full");
  const numbers: Array<[string, string, string]> = [
    [
      "of attacks got paid without POI",
      pct(full?.undefendedAsr),
      full
        ? `${full.undefendedAsr.k}/${full.undefendedAsr.n} agent purchases`
        : "run the benchmark",
    ],
    [
      "got paid with POI",
      pct(full?.defendedAsr),
      full ? `${full.defendedAsr.k}/${full.defendedAsr.n}` : "",
    ],
    [
      "of good purchases wrongly voided",
      pct(benign?.falseVoidRate),
      benign?.falseVoidRate ? `${benign.falseVoidRate.k}/${benign.falseVoidRate.n}` : "",
    ],
  ];
  return (
    <div className="space-y-16">
      <section className="pt-6">
        <p className="text-sm font-semibold text-brand">
          Semantic checkout firewall for AI shopping agents on PayPal
        </p>
        <h1 className="mt-3 max-w-3xl text-4xl font-black leading-tight tracking-tight sm:text-5xl">
          Signed mandates prove you said yes. POI proves the agent bought what you meant.
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-muted">
          An agent can follow a hidden instruction, accept a sneaky subscription or buy from a
          look-alike seller and still hold a valid signature. ProofOfIntent re-reads the real PayPal
          order, checks it against what you signed, and only then captures, voids or asks you.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/shop"
            className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white"
          >
            Try the live demo
          </Link>
          <Link
            href="/bazaar"
            className="rounded-xl border border-line px-5 py-2.5 text-sm font-semibold"
          >
            See the poisoned store
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {[
          [
            "1. Sign what you mean",
            "POI turns your words into a strict spec (budget all-in, no subscriptions, new only…), asks about gaps instead of guessing, and you sign it.",
          ],
          [
            "2. The agent shops",
            "Any agent, any model. The merchant creates a PayPal order with intent AUTHORIZE, so approving it only places a hold.",
          ],
          [
            "3. POI decides",
            "Rules, a spotlighted LLM judge, the merchant's fine print and a counterfactual re-run check the real order. CAPTURE, VOID (free), or ask you.",
          ],
        ].map(([title, body]) => (
          <div key={title} className="rounded-2xl border border-line bg-white p-5 dark:bg-zinc-900">
            <h2 className="font-semibold">{title}</h2>
            <p className="mt-2 text-sm text-muted">{body}</p>
          </div>
        ))}
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          IntentBench-mini
        </h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          {numbers.map(([label, value, sub]) => (
            <div
              key={label}
              className="rounded-2xl border border-line bg-white p-5 dark:bg-zinc-900"
            >
              <p className="text-4xl font-black tracking-tight">{value}</p>
              <p className="mt-1 text-sm">{label}</p>
              <p className="text-xs text-muted">{sub}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">
          {s ? `${s.note} ` : "No results yet. "}
          <Link href="/bench" className="text-brand underline">
            Full scorecard
          </Link>
        </p>
      </section>
    </div>
  );
}
