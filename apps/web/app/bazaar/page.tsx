import { BazaarClient } from "./bazaar-client";

export const metadata = { title: "Bazaar -- ProofOfIntent" };

export default function BazaarPage() {
  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">The Bazaar</h1>
        <p className="mt-1 text-sm text-muted">
          A store that looks honest. Turn on the agent's-eye view to see what an AI shopper actually
          reads.
        </p>
      </div>
      <BazaarClient />
    </>
  );
}
