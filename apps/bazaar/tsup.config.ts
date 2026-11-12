import { defineConfig } from "tsup";

// Workspace packages ship TypeScript source, so bundle them into dist; real npm deps stay external.
// (A config file because tsup 9's CLI reads `--no-external` as "negate --external" and fails.)
export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  clean: true,
  noExternal: [/^@poi\//],
});
