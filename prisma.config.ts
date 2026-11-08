import { existsSync } from "node:fs";
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

if (existsSync(".env")) config({ path: ".env", quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Fallback matches docker-compose so `prisma generate` works in CI without a .env.
    url: process.env.DATABASE_URL ?? "postgresql://poi:poi@localhost:5432/poi",
  },
});
