import { runShopper } from "./index";

// Usage: pnpm --filter @poi/agent shop "USB-C hub under $40, one-time, new only" --model openai:gpt-4o-mini
const args = process.argv.slice(2);
const modelFlag = args.indexOf("--model");
const model = modelFlag >= 0 ? (args[modelFlag + 1] ?? "") : "openai:gpt-4o-mini";
const userText = args.filter((_, i) => i !== modelFlag && i !== modelFlag + 1).join(" ");

const { trace, checkout } = await runShopper({
  userText,
  model,
  bazaarUrl: process.env.BAZAAR_URL ?? "http://localhost:4100",
});
console.log(
  JSON.stringify({ steps: trace.steps.length, chosenSkus: trace.chosenSkus, checkout }, null, 2),
);
