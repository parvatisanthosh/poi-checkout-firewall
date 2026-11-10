import { PageHeader } from "@/components/ui";
import { LedgerClient } from "./ledger-client";

export const metadata = { title: "Verdict ledger -- ProofOfIntent" };

export default function LedgerPage() {
  return (
    <>
      <PageHeader
        eyebrow="Verdict ledger"
        title="Every order."
        accent="Every verdict."
        lead="Each order POI has judged, newest first -- the latest stand in the firewall above. Live rows update as PayPal settles."
        className="min-h-[70vh]"
      />
      <LedgerClient />
    </>
  );
}
