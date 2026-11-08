import { agentModels, BAZAAR_URL } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Models the demo may run, and the Bazaar's scenarios (best effort). */
export async function GET() {
  const scenarios = await fetch(`${BAZAAR_URL}/scenarios`, {
    signal: AbortSignal.timeout(2000),
    cache: "no-store",
  })
    .then((r) =>
      r.ok ? (r.json() as Promise<Array<{ id: string; family: string; userText: string }>>) : [],
    )
    .catch(() => []);
  return Response.json({
    models: agentModels(),
    scenarios: scenarios.map((s) => ({ id: s.id, family: s.family, userText: s.userText })),
  });
}
