import { BAZAAR_URL } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Proxies the Bazaar's order preview so the browser sees the exact lines the merchant sent. */
export async function POST(req: Request) {
  const res = await fetch(`${BAZAAR_URL}/checkout/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!res)
    return Response.json(
      { error: { code: "BAZAAR_DOWN", message: "Bazaar unreachable" } },
      { status: 502 },
    );
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
