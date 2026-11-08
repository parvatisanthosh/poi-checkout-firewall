import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// One .env at the repo root for every app. Next only reads apps/web/.env*, so load the root one
// here (NEXT_PUBLIC_* values are inlined at build time from process.env).
const here = dirname(fileURLToPath(import.meta.url));
const rootEnv = join(here, "..", "..", ".env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@poi/shared", "@poi/agent"],
};

export default nextConfig;
