import { cpSync } from "node:fs";
import { defineConfig } from "tsup";

// Workspace packages ship TypeScript source, so bundle them into dist; real npm deps stay external.
export default defineConfig({
  entry: ["src/server.ts", "src/worker.ts", "src/arena-worker.ts", "src/calibrate.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  sourcemap: true,
  clean: true,
  noExternal: [/^@poi\//],
  // @poi/arena reads its attacker prompts from `<module dir>/../prompts`. Bundled, the module dir
  // is apps/api/dist, so ship a copy at apps/api/prompts (gitignored) or the prompts load empty.
  async onSuccess() {
    cpSync("../../packages/arena/prompts", "prompts", { recursive: true });
  },
});
