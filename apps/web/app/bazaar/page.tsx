import { PageHeader } from "@/components/ui";
import { BazaarClient } from "./bazaar-client";

export const metadata = { title: "Bazaar -- ProofOfIntent" };

export default function BazaarPage() {
  return (
    <>
      <PageHeader
        eyebrow="The Bazaar · synthetic store"
        title="Looks honest."
        accent="Reads otherwise."
        lead="A store built to fool shopping agents. Turn on the agent's-eye view to see what an AI shopper actually reads -- the hidden notes, the fine print, the look-alike sellers."
      />
      <BazaarClient />
    </>
  );
}
