import { VerifyClient } from "./verify-client";

export const metadata = { title: "Verify an order -- ProofOfIntent" };

export default function VerifyPage({ params }: { params: { orderId: string } }) {
  const orderId = decodeURIComponent(params.orderId);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Order {orderId}</h1>
      <p className="mb-6 mt-1 text-sm text-muted">
        What the user signed, what PayPal says was ordered, what POI checked, and the signed
        evidence.
      </p>
      <VerifyClient orderId={orderId} />
    </>
  );
}
