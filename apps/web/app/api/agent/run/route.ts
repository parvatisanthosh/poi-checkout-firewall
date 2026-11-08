// POST /api/agent/run -- runs the shopping agent server-side and streams its steps over SSE:
//   event: step   data: AgentStep
//   event: result data: { trace, checkout?, summary? }
//   event: error  data: { message }
import { z } from "zod";
import { runShopper } from "@poi/agent";
import { agentModels, BAZAAR_URL } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  userText: z.string().min(1).max(2000),
  model: z.string().min(3),
  scenario: z.string().max(64).optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: { code: "VALIDATION_ERROR", message: z.prettifyError(parsed.error) } },
      { status: 400 },
    );
  const { userText, model, scenario } = parsed.data;
  const allowed = agentModels().find((m) => m.id === model);
  if (!allowed)
    return Response.json(
      { error: { code: "MODEL_NOT_ALLOWED", message: `${model} is not in AGENT_MODELS` } },
      { status: 400 },
    );
  if (!allowed.available)
    return Response.json(
      { error: { code: "MODEL_KEY_MISSING", message: `No API key for ${model} on this server` } },
      { status: 503 },
    );

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        const result = await runShopper({
          userText,
          model,
          bazaarUrl: BAZAAR_URL,
          ...(scenario ? { scenario } : {}),
          onStep: (s) => send("step", s),
          abortSignal: req.signal,
        });
        send("result", result);
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
