// P9: terms RAG. Catches the clause in the fine print ("trial converts to $9.99/mo") that the
// order line hides. pgvector cosine search scoped to the merchant; keyword fallback when no
// embedding model is configured (chunks are then stored without embeddings).
import { embed, embedMany, type EmbeddingModel } from "ai";
import { toCents, type CheckResult, type NormalizedOrder } from "@poi/shared";
import type { PrismaClient } from "../lib/prisma";

export const TERMS_QUERY_SUFFIX =
  "automatic renewal subscription trial cancellation restocking fee refurbished condition warranty";

export interface TermsChunk {
  id: string;
  text: string;
  distance?: number;
}

// --- chunking -----------------------------------------------------------------------------

/** Split Markdown by headings, then pack paragraphs into ~`target`-char chunks. */
export function chunkTerms(markdown: string, target = 500): string[] {
  const sections = markdown
    .split(/\n(?=#{1,6}\s)/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  for (const section of sections) {
    const heading = /^#{1,6}\s.*$/m.exec(section)?.[0] ?? "";
    const body = heading ? section.slice(heading.length).trim() : section;
    const paras = body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    let cur = heading;
    for (const p of paras.length ? paras : [""]) {
      if (cur && cur.length + p.length + 2 > target && cur !== heading) {
        chunks.push(cur.trim());
        cur = heading ? `${heading} (cont.)` : "";
      }
      cur = cur ? `${cur}\n\n${p}` : p;
    }
    if (cur.trim()) chunks.push(cur.trim());
  }
  return chunks.filter((c) => c.replace(/^#.*$/m, "").trim().length > 0);
}

// --- ingest -------------------------------------------------------------------------------

/** Replace a merchant's chunks. Idempotent: delete then insert, in one transaction. */
export async function ingestMerchantTerms(
  prisma: PrismaClient,
  merchantId: string,
  markdown: string,
  embeddingModel?: EmbeddingModel,
): Promise<number> {
  const chunks = chunkTerms(markdown);
  const vectors =
    embeddingModel && chunks.length
      ? (await embedMany({ model: embeddingModel, values: chunks })).embeddings
      : undefined;
  await prisma.$transaction(async (tx) => {
    await tx.termsChunk.deleteMany({ where: { merchantId } });
    for (const [i, text] of chunks.entries()) {
      const id = `${merchantId}:${i}`;
      const vec = vectors?.[i];
      if (vec) {
        await tx.$executeRaw`INSERT INTO "TermsChunk" (id, "merchantId", text, embedding) VALUES (${id}, ${merchantId}, ${text}, ${`[${vec.join(",")}]`}::vector)`;
      } else {
        await tx.termsChunk.create({ data: { id, merchantId, text } });
      }
    }
  });
  return chunks.length;
}

// --- retrieval ----------------------------------------------------------------------------

export function termsQuery(order: NormalizedOrder): string {
  return `${order.lines.map((l) => l.name).join(" ")} ${TERMS_QUERY_SUFFIX}`;
}

const KEYWORDS = TERMS_QUERY_SUFFIX.split(" ").concat([
  "renew",
  "monthly",
  "per month",
  "/mo",
  "convert",
  "charge",
  "fee",
  "recurring",
]);

function keywordScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const words = new Set([
    ...KEYWORDS,
    ...query
      .toLowerCase()
      .split(/[^a-z0-9/]+/)
      .filter((w) => w.length > 3),
  ]);
  return [...words].filter((w) => t.includes(w)).length;
}

export async function retrieveTerms(
  prisma: PrismaClient,
  merchantId: string,
  order: NormalizedOrder,
  opts: { embeddingModel?: EmbeddingModel; k?: number } = {},
): Promise<TermsChunk[]> {
  const k = opts.k ?? 4;
  const query = termsQuery(order);
  if (opts.embeddingModel) {
    const { embedding } = await embed({ model: opts.embeddingModel, value: query });
    const vec = `[${embedding.join(",")}]`;
    const rows = await prisma.$queryRaw<Array<{ id: string; text: string; distance: number }>>`
      SELECT id, text, (embedding <=> ${vec}::vector) AS distance
      FROM "TermsChunk"
      WHERE "merchantId" = ${merchantId} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vec}::vector
      LIMIT ${k}`;
    if (rows.length)
      return rows.map((r) => ({ id: r.id, text: r.text, distance: Number(r.distance) }));
  }
  const all = await prisma.termsChunk.findMany({
    where: { merchantId },
    select: { id: true, text: true },
  });
  return all
    .map((c) => ({ ...c, score: keywordScore(c.text, query) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ id, text }) => ({ id, text }));
}

// --- deterministic pass over retrieved chunks ----------------------------------------------

export const RECURRING_CLAUSE =
  /\$\s?\d+(?:\.\d{2})?\s*(?:\/|per\s)\s*(?:mo|month|yr|year|week)\b|\bauto(?:matic(?:ally)?)?[- ]?renew\w*|\bconverts? (?:in)?to (?:a )?(?:paid|monthly|annual|yearly)|\bwill (?:then )?be (?:charged|billed) (?:monthly|annually|every)|\btrial (?:converts|ends|then|period ends)\b|\bbilled (?:monthly|annually|every)\b|\brecurring (?:charge|fee|payment)s?\b/i;
const FEE_CLAUSE = /\brestocking fee\b|\b(?:service|processing|handling|cancellation) fee\b/i;

// Words too generic to tie a clause to an order line.
const GENERIC = new Set(
  "with from your this that these those include includes included free first month months monthly year years annual days plan plans order orders item items product products purchase charge charged billed cancel until after before when each every edition pack bundle".split(
    " ",
  ),
);
const wordSet = (s: string) =>
  new Set(
    s
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4),
  );

/**
 * Does a recurring clause apply to THIS order? Yes when the clause names something an order line
 * names (e.g. "KordiaCloud", "DeskCare"), ignoring brand, category and generic words -- or when the
 * order carries a $0.00 line (a free trial is the classic hook). Without an order, assume it applies.
 */
export function clauseApplies(chunk: string, order?: NormalizedOrder, merchantName = ""): boolean {
  if (!order) return true;
  if (order.lines.some((l) => toCents(l.unitAmount) === 0)) return true;
  const skip = new Set([...GENERIC, ...wordSet(merchantName)]);
  const lineWords = new Set(
    order.lines
      .flatMap((l) => [...wordSet(`${l.name} ${l.description ?? ""}`)])
      .filter((w) => !skip.has(w)),
  );
  const chunkWords = wordSet(chunk);
  return [...lineWords].some((w) => chunkWords.has(w));
}

/**
 * "terms" checks (stage "rag"). A recurring/auto-renew clause that applies to the order -> warn
 * high (ASK_HUMAN); one that doesn't -> warn low (shown, never blocks). Fees -> warn medium.
 */
export function termsChecks(
  chunks: TermsChunk[],
  latencyMs: number,
  order?: NormalizedOrder,
  merchantName?: string,
): CheckResult[] {
  const out: CheckResult[] = [];
  chunks.forEach((c, i) => {
    const m = RECURRING_CLAUSE.exec(c.text);
    if (m) {
      const applies = clauseApplies(c.text, order, merchantName);
      out.push({
        check: "terms",
        stage: "rag",
        outcome: "warn",
        severity: applies ? "high" : "low",
        field: `/terms/${i}`,
        actual: `"${m[0]}"`,
        reason: applies
          ? `The merchant's terms add a recurring charge to what you're buying ("${m[0]}"). A person should confirm before paying.`
          : `The merchant's terms mention a recurring charge ("${m[0]}") for something not in this order.`,
        latencyMs,
      });
      return;
    }
    const f = FEE_CLAUSE.exec(c.text);
    if (f) {
      out.push({
        check: "terms",
        stage: "rag",
        outcome: "warn",
        severity: "medium",
        field: `/terms/${i}`,
        actual: `"${f[0]}"`,
        reason: `The merchant's terms mention a ${f[0]}.`,
        latencyMs,
      });
    }
  });

  return out.length
    ? out
    : [
        {
          check: "terms",
          stage: "rag",
          outcome: "pass",
          severity: "low",
          reason: chunks.length
            ? "The merchant's terms add no recurring charges or fees."
            : "No merchant terms on file to check.",
          latencyMs,
        },
      ];
}
