// pnpm bench:freeze [--force] -- compile each scenario's userText once with POI and freeze it in
// bench/intents/<id>.json, so compiler variance never leaks into verifier results. Review the
// files by hand (and commit them) before a full run.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPoiClient } from "@poi/shared";
import { loadScenarios } from "./oracle";

const dir = fileURLToPath(new URL("../intents/", import.meta.url));
mkdirSync(dir, { recursive: true });
const force = process.argv.includes("--force");
const poi = createPoiClient({ baseUrl: process.env.POI_API_URL ?? "http://localhost:4000" });

for (const s of loadScenarios()) {
  const file = `${dir}${s.id}.json`;
  if (existsSync(file) && !force) continue;
  const { draft, ambiguities } = await poi.compileIntent(s.userText);
  const open = ambiguities.filter((a) => !a.resolvedWith);
  if (open.length) {
    console.warn(
      `  ${s.id}: unresolved ${open.map((a) => a.field).join(", ")} -- fix the scenario text or edit the file`,
    );
  }
  writeFileSync(file, `${JSON.stringify(draft, null, 2)}\n`);
  console.log(
    `  ${s.id}: max ${draft.maxTotal.value}, ${draft.category}, must ${draft.mustHave.join("/") || "-"}`,
  );
}
