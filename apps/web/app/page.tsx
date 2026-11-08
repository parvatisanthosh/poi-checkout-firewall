import { formatMoney } from "@poi/shared";
import { demoSpec } from "@poi/shared/fixtures";

// Hello-world skeleton (tasks F4-F8, owned by the teammate).
export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-3xl font-semibold">ProofOfIntent</h1>
      <p className="mt-2 text-zinc-500">Semantic Checkout Firewall</p>
      <p className="mt-8">
        Signed mandates prove you said yes. ProofOfIntent proves the agent bought what you meant.
      </p>
      <p className="mt-8 text-sm text-zinc-500">
        Shared contracts loaded: demo intent budget {formatMoney(demoSpec.maxTotal)}.
      </p>
    </main>
  );
}
