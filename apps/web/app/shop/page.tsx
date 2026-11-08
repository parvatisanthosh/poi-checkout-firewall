import { ShopClient } from "./shop-client";

export const metadata = { title: "Live demo -- ProofOfIntent" };

export default function ShopPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Live demo</h1>
      <p className="mb-8 mt-1 text-sm text-muted">
        Sign what you mean, let an AI agent shop the Bazaar, and watch POI decide before any money
        moves.
      </p>
      <ShopClient />
    </>
  );
}
