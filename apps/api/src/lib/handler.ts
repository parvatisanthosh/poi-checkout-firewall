import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";

interface Schemas<B, Q, P, R> {
  body?: z.ZodType<B>;
  query?: z.ZodType<Q>;
  params?: z.ZodType<P>;
  /** Response contract. Output is parsed through it, so a handler can't drift from CONTRACTS.md. */
  response?: z.ZodType<R>;
  status?: number;
}

interface Input<B, Q, P> {
  body: B;
  query: Q;
  params: P;
}

/**
 * Zod request validation as a route wrapper: body, query and params are parsed before the
 * handler runs (a ZodError becomes a 400 in the error handler), and the handler gets them
 * typed. The return value is validated against `response` and sent as JSON.
 */
export function handle<B = unknown, Q = unknown, P = unknown, R = unknown>(
  schemas: Schemas<B, Q, P, R>,
  fn: (input: Input<B, Q, P>, req: Request, res: Response) => Promise<R> | R,
): RequestHandler {
  return async (req, res) => {
    const input: Input<B, Q, P> = {
      body: schemas.body ? schemas.body.parse(req.body ?? {}) : (req.body as B),
      query: schemas.query ? schemas.query.parse(req.query) : (req.query as Q),
      params: schemas.params ? schemas.params.parse(req.params) : (req.params as P),
    };
    const result = await fn(input, req, res);
    if (res.headersSent) return;
    let out: unknown = result;
    if (schemas.response) {
      // A response that breaks the contract is our bug: 500, not a 400 for the caller.
      const parsed = schemas.response.safeParse(result);
      if (!parsed.success) {
        throw new Error(
          `response contract violation on ${req.method} ${req.path}: ${z.prettifyError(parsed.error)}`,
        );
      }
      out = parsed.data;
    }
    res.status(schemas.status ?? 200).json(out);
  };
}
