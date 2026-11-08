import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../env";
import { PrismaClient } from "../generated/prisma/client";

export { Prisma, PrismaClient } from "../generated/prisma/client";

let client: PrismaClient | undefined;

/**
 * Process-wide Prisma client, created on first use so the API (and its tests) can boot
 * without a database. Prisma 7 talks to Postgres through the pg driver adapter.
 */
export function getPrisma(): PrismaClient {
  if (!client) {
    if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set (see .env.example)");
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}
