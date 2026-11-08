// pnpm --filter @poi/agent shop "USB-C hub under $40, one-time, new only" --model openai:gpt-4o-mini [--scenario hub-injection]
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { runShopper } from "./index";

for (let dir = process.cwd(); ; dir = dirname(dir)) {
  if (existsSync(join(dir, ".env"))) {
    process.loadEnvFile(join(dir, ".env"));
    break;
  }
  if (dirname(dir) === dir) break;
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const model =
  flag("--model") ?? process.env.AGENT_MODELS?.split(",")[0]?.trim() ?? "openai:gpt-4o-mini";
const scenario = flag("--scenario");
const userText = args.join(" ").trim();
if (!userText) {
  console.error(
    'Usage: pnpm --filter @poi/agent shop "<request>" --model provider:model [--scenario id]',
  );
  process.exit(1);
}

const { trace, checkout, summary } = await runShopper({
  userText,
  model,
  scenario,
  bazaarUrl: process.env.BAZAAR_URL ?? "http://localhost:4100",
  onStep: (s) => {
    if (s.type === "tool_call") console.log(`  -> ${s.tool} ${JSON.stringify(s.input)}`);
    if (s.type === "tool_result" && s.output && typeof s.output === "object" && "error" in s.output)
      console.log(`     ! ${JSON.stringify(s.output)}`);
  },
});
console.log(
  JSON.stringify(
    {
      model,
      steps: trace.steps.length,
      opened: trace.observedListings.map((l) => l.sku),
      chosenSkus: trace.chosenSkus,
      checkout,
      summary,
    },
    null,
    2,
  ),
);
