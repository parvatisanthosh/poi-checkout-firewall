import { createPoiClient } from "@poi/shared";
import { parseModelList } from "@poi/shared/llm";

// Skeleton for IntentBench-mini (task F7, owned by the teammate).
const models = parseModelList(process.env.AGENT_MODELS);
const poi = createPoiClient({ baseUrl: process.env.POI_API_URL ?? "http://localhost:4000" });
const health = await poi.health();
console.log(
  `[bench] skeleton -- POI health ok=${health.ok}; models: ${models.join(", ") || "(none set)"}`,
);
