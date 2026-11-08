import { createServer } from "node:http";
import { env } from "./env";
import { createApp } from "./app";

const server = createServer(createApp());

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[api] port ${env.API_PORT} is busy -- is the mock API (pnpm mock:api) running?`);
    process.exit(1);
  }
  throw err;
});

server.listen(env.API_PORT, () => {
  console.log(`[api] POI API on http://localhost:${env.API_PORT}/api`);
});
