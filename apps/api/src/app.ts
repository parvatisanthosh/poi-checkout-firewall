import express from "express";
import type { HealthResponse } from "@poi/shared";

/**
 * P0 skeleton. P2 adds helmet, cors, pino, Zod validation middleware and the
 * central error handler; later tasks mount the real routes.
 */
export function createApp() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    // P2 replaces these with real db / redis / PayPal token checks.
    const body: HealthResponse = { ok: true, db: false, redis: false, paypal: false };
    res.json(body);
  });

  return app;
}
