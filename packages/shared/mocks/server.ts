import { createMockApp } from "./app";

const port = Number(process.env.MOCK_PORT ?? process.env.API_PORT ?? 4000);
const { httpServer } = createMockApp();

httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[mock] port ${port} is busy -- is apps/api (pnpm dev) already running?`);
    process.exit(1);
  }
  throw err;
});

httpServer.listen(port, () => {
  console.log(`[mock] POI mock API on http://localhost:${port}/api  (socket namespace /live)`);
  console.log(`[mock] try: curl http://localhost:${port}/api/verifications/demo`);
});
