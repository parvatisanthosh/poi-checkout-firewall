import { Card } from "@/components/ui";
import { readBenchSummary } from "@/lib/server";
import { Scorecard } from "./scorecard";

export const metadata = { title: "Attack scorecard -- ProofOfIntent" };
export const dynamic = "force-dynamic";

export default function BenchPage() {
  const summary = readBenchSummary();
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Attack scorecard</h1>
      <p className="mb-6 mt-1 max-w-3xl text-sm text-muted">
        IntentBench-mini: real shopping agents on the adversarial Bazaar, each purchase verified
        under every POI configuration. Ground truth comes from scenario labels, never from POI.
        Every rate shows its counts; hover for the 95% interval.
      </p>
      {summary ? (
        <Scorecard summary={summary} />
      ) : (
        <Card title="No benchmark results yet">
          <p className="text-sm text-muted">
            Run <code className="font-mono">pnpm bench:smoke</code> (or{" "}
            <code className="font-mono">pnpm bench</code>) with the API, Bazaar and agent model keys
            configured, then <code className="font-mono">pnpm bench:summarize</code>. The scorecard
            reads <code className="font-mono">bench/results/summary.json</code>.
          </p>
        </Card>
      )}
    </>
  );
}
