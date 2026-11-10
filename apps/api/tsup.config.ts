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
});
