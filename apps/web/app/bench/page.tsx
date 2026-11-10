import { Card, PageHeader } from "@/components/ui";
import { readBenchSummary } from "@/lib/server";
import { Scorecard } from "./scorecard";

export const metadata = { title: "Attack scorecard -- ProofOfIntent" };
export const dynamic = "force-dynamic";

export default function BenchPage() {
  const summary = readBenchSummary();
  return (
    <>
      <PageHeader
        eyebrow="IntentBench-mini · scorecard"
        title="Measured,"
        accent="not claimed."
        lead="Real shopping agents on the adversarial Bazaar, each purchase verified under every POI configuration. Ground truth comes from scenario labels, never from POI. Every rate shows its counts; hover for the 95% interval."
      />
      {summary ? (
        <Scorecard summary={summary} />
      ) : (
        <Card title="No benchmark results yet" corners>
          <p className="text-sm text-muted">
            Run <code className="font-mono text-ice">pnpm bench:smoke</code> (or{" "}
            <code className="font-mono text-ice">pnpm bench</code>) with the API, Bazaar and agent
            model keys configured, then{" "}
            <code className="font-mono text-ice">pnpm bench:summarize</code>. The scorecard reads{" "}
            <code className="font-mono text-ice">bench/results/summary.json</code>.
          </p>
        </Card>
      )}
    </>
  );
}
