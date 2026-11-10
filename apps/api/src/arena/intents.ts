// The signed intent an arena trial's orders are verified against: the scenario's request compiled
// and signed once per (run, scenario), under a deterministic id so retries and parallel trials
// share it.
import { createHash } from "node:crypto";
import { IntentSpec, toCents, type Scenario } from "@poi/shared";
import type { LanguageModel } from "ai";
import type { SigningKey } from "../evidence/keys";
import { compileIntent } from "../intent/compiler";
import { buildMandate } from "../intent/mandate";
import { hashSpec, signIntent } from "../intent/sign";
import type { Prisma, PrismaClient } from "../lib/prisma";

export interface ArenaIntentDeps {
  prisma: () => PrismaClient;
  signingKey: () => Promise<SigningKey>;
  compilerModel?: LanguageModel;
}

export const arenaIntentId = (runId: string, scenarioId: string) =>
  `int_arena_${createHash("sha256").update(`${runId}|${scenarioId}`).digest("base64url").slice(0, 22)}`;

export async function ensureArenaIntent(
  deps: ArenaIntentDeps,
  runId: string,
  scenario: Scenario,
): Promise<{ intentId: string; spec: IntentSpec }> {
  const db = deps.prisma();
  const id = arenaIntentId(runId, scenario.id);
  const existing = await db.intent.findUnique({ where: { id } });
  if (existing) return { intentId: id, spec: IntentSpec.parse(existing.spec) };

  const merchants = await db.merchant.findMany();
  const { draft } = await compileIntent(scenario.userText, {
    model: deps.compilerModel,
    merchants,
  });
  if (toCents(draft.maxTotal) <= 0)
    throw new Error(`scenario ${scenario.id}: request has no budget, can't sign an intent`);
  const key = await deps.signingKey();
  const issuedAt = new Date();
  const specHash = hashSpec(draft);
  const jws = await signIntent(key, { intentId: id, specHash, issuedAt });
  const mandate = buildMandate(draft, { intentId: id, specHash, issuedAt });
  try {
    await db.intent.create({
      data: {
        id,
        rawText: draft.rawText,
        spec: draft as Prisma.InputJsonValue,
        specHash,
        jws,
        mandate: mandate as Prisma.InputJsonValue,
        createdAt: issuedAt,
      },
    });
    return { intentId: id, spec: draft };
  } catch {
    // A parallel trial created it first: use theirs.
    const row = await db.intent.findUniqueOrThrow({ where: { id } });
    return { intentId: id, spec: IntentSpec.parse(row.spec) };
  }
}
