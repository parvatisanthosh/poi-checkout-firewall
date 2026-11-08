import { Router } from "express";
import {
  CompileIntentRequest,
  CompileIntentResponse,
  GetIntentResponse,
  IntentMandate,
  IntentSpec,
  SignIntentRequest,
  SignIntentResponse,
  toCents,
} from "@poi/shared";
import { z } from "zod";
import type { AppDeps } from "../app";
import { HttpError } from "../lib/errors";
import { handle } from "../lib/handler";
import { compileIntent } from "../intent/compiler";
import { buildMandate } from "../intent/mandate";
import { hashSpec, newIntentId, signIntent } from "../intent/sign";

type Deps = Pick<AppDeps, "prisma" | "signingKey" | "compilerModel" | "logger">;

export function intentsRouter(deps: Deps): Router {
  const r = Router();

  r.post(
    "/intents/compile",
    handle(
      { body: CompileIntentRequest, response: CompileIntentResponse },
      async ({ body }, req) => {
        // The registry lets the compiler map "from Voltra Official" to an id. No DB = no mapping.
        const merchants = await deps
          .prisma()
          .merchant.findMany()
          .catch(() => []);
        const { draft, ambiguities, source } = await compileIntent(body.text, {
          model: deps.compilerModel,
          merchants,
          logger: req.log,
        });
        req.log.info({ source, ambiguities: ambiguities.length }, "intent compiled");
        return { draft, ambiguities };
      },
    ),
  );

  r.post(
    "/intents",
    handle(
      { body: SignIntentRequest, response: SignIntentResponse, status: 201 },
      async ({ body }) => {
        const spec = body.spec;
        if (toCents(spec.maxTotal) <= 0) {
          throw new HttpError(
            422,
            "INTENT_INCOMPLETE",
            "maxTotal must be greater than zero before signing",
          );
        }
        if (spec.maxTotal.currency !== "USD") {
          throw new HttpError(422, "UNSUPPORTED_CURRENCY", "Only USD intents are supported");
        }
        const key = await deps.signingKey();
        const intentId = newIntentId();
        const issuedAt = new Date();
        const specHash = hashSpec(spec);
        const jws = await signIntent(key, { intentId, specHash, issuedAt });
        const mandate = buildMandate(spec, { intentId, specHash, issuedAt });
        await deps.prisma().intent.create({
          data: {
            id: intentId,
            rawText: spec.rawText,
            spec,
            specHash,
            jws,
            mandate,
            createdAt: issuedAt,
          },
        });
        return { intentId, mandate, jws };
      },
    ),
  );

  r.get(
    "/intents/:id",
    handle(
      { params: z.object({ id: z.string().min(1).max(64) }), response: GetIntentResponse },
      async ({ params }) => {
        const row = await deps.prisma().intent.findUnique({ where: { id: params.id } });
        if (!row) throw new HttpError(404, "INTENT_NOT_FOUND", `Intent ${params.id} not found`);
        return {
          intent: {
            intentId: row.id,
            rawText: row.rawText,
            spec: IntentSpec.parse(row.spec),
            specHash: row.specHash,
            status: row.status,
            createdAt: row.createdAt.toISOString(),
          },
          mandate: IntentMandate.parse(row.mandate),
          jws: row.jws,
        };
      },
    ),
  );

  return r;
}

/** Public key for verifying intent and evidence signatures. Served at both /.well-known and /api/.well-known. */
export function jwksRouter(deps: Pick<AppDeps, "signingKey">): Router {
  const r = Router();
  r.get(
    "/.well-known/jwks.json",
    handle({}, async () => ({ keys: [(await deps.signingKey()).publicJwk] })),
  );
  return r;
}
