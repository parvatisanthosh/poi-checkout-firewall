import { Router } from "express";
import { MerchantsResponse } from "@poi/shared";
import type { AppDeps } from "../app";
import { handle } from "../lib/handler";

export function merchantsRouter(deps: Pick<AppDeps, "prisma">): Router {
  const r = Router();

  r.get(
    "/merchants",
    handle({ response: MerchantsResponse }, async () => {
      const rows = await deps.prisma().merchant.findMany({ orderBy: { displayName: "asc" } });
      return rows.map((m) => ({ id: m.id, displayName: m.displayName, verified: m.verified }));
    }),
  );

  return r;
}
