import { LedgerClient } from "./ledger-client";

export const metadata = { title: "Verdict ledger -- ProofOfIntent" };

export default function LedgerPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Verdict ledger</h1>
      <p className="mb-6 mt-1 text-sm text-muted">
        Every order POI has judged, newest first. Live rows update as PayPal settles.
      </p>
      <LedgerClient />
    </>
  );
}
