// Antibody persistence (CONTRACTS-L2 4.2): rows, the LSH band index, pgvector embeddings, and the
// version bookkeeping that lets snapshotDefender(v) say exactly which antibodies were live at v.
import {
  Antibody,
  AntibodyAction,
  AttackFamily,
  type AntibodyStatus,
  type AntibodySummary,
} from "@poi/shared";
import type { Prisma, PrismaClient } from "../lib/prisma";
import { toVectorLiteral } from "../lib/vector";
import { lshBands } from "./lsh";

type Db = PrismaClient | Prisma.TransactionClient;
type DbState = "CANDIDATE" | "ACTIVE" | "RETIRED";

const toStatus = (s: DbState): AntibodyStatus => s.toLowerCase() as AntibodyStatus;
const toDbState = (s: AntibodyStatus): DbState => s.toUpperCase() as DbState;

interface AntibodyRowDb {
  id: string;
  family: string;
  sourceOrderId: string;
  minhash: number[];
  features: unknown;
  skeleton: string | null;
  action: string;
  state: DbState;
  hits: number;
  falseHits: number;
  defenderVersion: number;
  signature: string;
  createdAt: Date;
}

export function toAntibody(r: AntibodyRowDb): Antibody {
  return Antibody.parse({
    id: r.id,
    family: AttackFamily.parse(r.family),
    sourceOrderId: r.sourceOrderId,
    minhash: r.minhash,
    features: r.features,
    skeleton: r.skeleton,
    action: AntibodyAction.parse(r.action),
    status: toStatus(r.state),
    hits: r.hits,
    falseHits: r.falseHits,
    defenderVersion: r.defenderVersion,
    signature: r.signature,
  });
}

export function toSummary(r: AntibodyRowDb): AntibodySummary {
  const { minhash: _minhash, ...rest } = toAntibody(r);
  return { ...rest, createdAt: r.createdAt.toISOString() };
}

export interface NewAntibody {
  family: Antibody["family"];
  sourceOrderId: string;
  minhash: number[];
  features: Record<string, boolean>;
  skeleton: string | null;
  action: Antibody["action"];
  /** The defender version at mint time. */
  defenderVersion: number;
  signature: string;
}

/** Insert a CANDIDATE antibody with its 32 LSH bands (and embedding, if given) in one transaction. */
export async function insertCandidate(
  db: PrismaClient,
  a: NewAntibody,
  embedding?: number[],
): Promise<Antibody> {
  const bands = lshBands(a.minhash);
  return db.$transaction(async (tx) => {
    const row = await tx.antibody.create({
      data: {
        family: a.family,
        sourceOrderId: a.sourceOrderId,
        minhash: a.minhash,
        features: a.features,
        skeleton: a.skeleton,
        action: a.action,
        defenderVersion: a.defenderVersion,
        signature: a.signature,
      },
    });
    await tx.antibodyBand.createMany({
      data: bands.map((hash, band) => ({ band, hash, antibodyId: row.id })),
    });
    if (embedding) {
      await tx.$executeRaw`UPDATE "Antibody" SET embedding = ${toVectorLiteral(embedding)}::vector WHERE id = ${row.id}`;
    }
    return toAntibody(row);
  });
}

export async function getAntibody(db: Db, id: string): Promise<Antibody | null> {
  const r = await db.antibody.findUnique({ where: { id } });
  return r ? toAntibody(r) : null;
}

export async function listAntibodies(db: Db, status?: AntibodyStatus): Promise<AntibodySummary[]> {
  const rows = await db.antibody.findMany({
    where: status ? { state: toDbState(status) } : {},
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toSummary);
}

/**
 * LSH candidates: antibodies sharing at least one band hash with `minhash`. Scoped to ACTIVE
 * antibodies, or to an explicit id set (a pinned defender snapshot). Confirm with estimatedJaccard.
 */
export async function candidatesByBands(
  db: Db,
  minhash: number[],
  scope: { ids?: string[] } = {},
): Promise<Antibody[]> {
  const bands = lshBands(minhash);
  if (scope.ids && scope.ids.length === 0) return [];
  const rows = await db.antibody.findMany({
    where: {
      ...(scope.ids ? { id: { in: scope.ids } } : { state: "ACTIVE" }),
      bands: { some: { OR: bands.map((hash, band) => ({ band, hash })) } },
    },
  });
  return rows.map(toAntibody);
}

/** Top-k antibodies by cosine similarity of embeddings (ACTIVE, or the given id set). */
export async function nearestByEmbedding(
  db: Db,
  embedding: number[],
  opts: { k?: number; ids?: string[] } = {},
): Promise<Array<{ id: string; cosine: number }>> {
  const k = opts.k ?? 5;
  const vec = toVectorLiteral(embedding);
  if (opts.ids && opts.ids.length === 0) return [];
  const rows = opts.ids
    ? await db.$queryRaw<Array<{ id: string; cosine: number }>>`
        SELECT id, 1 - (embedding <=> ${vec}::vector) AS cosine FROM "Antibody"
        WHERE embedding IS NOT NULL AND id = ANY(${opts.ids})
        ORDER BY embedding <=> ${vec}::vector LIMIT ${k}`
    : await db.$queryRaw<Array<{ id: string; cosine: number }>>`
        SELECT id, 1 - (embedding <=> ${vec}::vector) AS cosine FROM "Antibody"
        WHERE embedding IS NOT NULL AND state = 'ACTIVE'
        ORDER BY embedding <=> ${vec}::vector LIMIT ${k}`;
  return rows.map((r) => ({ id: r.id, cosine: Number(r.cosine) }));
}

/** CANDIDATE -> ACTIVE at `version` (the version the promotion created). Use inside bumpVersion. */
export async function activateAntibody(db: Db, id: string, version: number): Promise<void> {
  const r = await db.antibody.updateMany({
    where: { id, state: "CANDIDATE" },
    data: { state: "ACTIVE", defenderVersion: version },
  });
  if (r.count !== 1) throw new Error(`antibody ${id} is not a candidate`);
}

/** A candidate that failed the promotion gate. Retired at its own mint version, so it was never live. */
export async function rejectCandidate(db: Db, id: string): Promise<void> {
  const a = await db.antibody.findUnique({
    where: { id },
    select: { state: true, defenderVersion: true },
  });
  if (a?.state !== "CANDIDATE") throw new Error(`antibody ${id} is not a candidate`);
  await db.antibody.update({
    where: { id },
    data: { state: "RETIRED", retiredVersion: a.defenderVersion },
  });
}

/** ACTIVE -> RETIRED at `version` (the version the retirement created). Use inside bumpVersion. */
export async function retireAntibody(db: Db, id: string, version: number): Promise<void> {
  const r = await db.antibody.updateMany({
    where: { id, state: "ACTIVE" },
    data: { state: "RETIRED", retiredVersion: version },
  });
  if (r.count !== 1) throw new Error(`antibody ${id} is not active`);
}

export async function recordHit(db: Db, id: string): Promise<void> {
  await db.antibody.update({ where: { id }, data: { hits: { increment: 1 } } });
}

/** A human approved an order this antibody escalated. Returns the new counts (for auto-retirement). */
export async function recordFalseHit(
  db: Db,
  id: string,
): Promise<{ hits: number; falseHits: number }> {
  return db.antibody.update({
    where: { id },
    data: { falseHits: { increment: 1 } },
    select: { hits: true, falseHits: true },
  });
}

/** Ids live at defender version v: activated at or before v and not retired by v. */
export async function liveAntibodyIdsAt(db: Db, version: number): Promise<string[]> {
  const rows = await db.antibody.findMany({
    where: {
      state: { in: ["ACTIVE", "RETIRED"] },
      defenderVersion: { lte: version },
      OR: [{ retiredVersion: null }, { retiredVersion: { gt: version } }],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => r.id);
}
