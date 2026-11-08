import { createPoiClient } from "@poi/shared";

// P11 turns this into a stdio MCP server (compile_intent, sign_intent, attach_order,
// verify_order, get_verdict, capture_if_verified). stdout is reserved for MCP, so log to stderr.
const poi = createPoiClient({ baseUrl: process.env.POI_API_URL ?? "http://localhost:4000" });
console.error(
  "[mcp] skeleton -- tools land in P11; client ready:",
  Object.keys(poi).length,
  "methods",
);
