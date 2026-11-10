import { PageHeader } from "@/components/ui";
import { ShopClient } from "./shop-client";

export const metadata = { title: "Live demo -- ProofOfIntent" };

export default function ShopPage() {
  return (
    <>
      <PageHeader
        eyebrow="Live demo · PayPal sandbox"
        title="Sign it. Shop it."
        accent="Watch POI decide."
        lead="Tell POI what you mean, let an AI agent shop the Bazaar, approve with PayPal -- and see the firewall re-read the real order before any money moves."
      />
      <ShopClient />
    </>
  );
}
