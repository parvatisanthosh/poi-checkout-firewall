import { PageHeader } from "@/components/ui";
import { VerifyClient } from "./verify-client";

export const metadata = { title: "Verify an order -- ProofOfIntent" };

export default function VerifyPage({ params }: { params: { orderId: string } }) {
  const orderId = decodeURIComponent(params.orderId);
  return (
    <>
      <PageHeader
        eyebrow={`Order · ${orderId}`}
        title="The record."
        lead="What the user signed, what PayPal says was ordered, what POI checked -- and the signed, hash-chained evidence anyone can recompute."
      />
      <VerifyClient orderId={orderId} />
    </>
  );
}
