import type { ErrorRequestHandler, RequestHandler } from "express";
import { z } from "zod";
import type { ApiErrorBody } from "@poi/shared";
import { PayPalError } from "../paypal/errors";

/** Throw from a handler to answer with { error: { code, message } } and this status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string, code = "NOT_FOUND") =>
  new HttpError(404, code, `${what} not found`);

function body(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(body("NOT_FOUND", `No route for ${req.method} ${req.path}`));
};

/**
 * Central error handler. Known errors map to their status and code; anything else is a 500
 * whose message is NOT sent to the client (it may contain internals), only logged.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json(body(err.code, err.message));
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json(body("VALIDATION_ERROR", z.prettifyError(err)));
    return;
  }
  if (err instanceof PayPalError) {
    req.log?.warn({ status: err.status, code: err.code, debugId: err.debugId }, "PayPal error");
    const message = `PayPal: ${err.message}${err.debugId ? ` (debug_id ${err.debugId})` : ""}`;
    res.status(err.status === 404 ? 404 : 502).json(body(`PAYPAL_${err.code}`, message));
    return;
  }
  // body-parser errors carry a `type` and an HTTP status
  const e = err as { type?: string; status?: number };
  if (e?.type === "entity.parse.failed") {
    res.status(400).json(body("INVALID_JSON", "Request body is not valid JSON"));
    return;
  }
  if (e?.type === "entity.too.large") {
    res.status(413).json(body("PAYLOAD_TOO_LARGE", "Request body is too large"));
    return;
  }
  req.log?.error({ err }, "unhandled error");
  res.status(500).json(body("INTERNAL", "Internal server error"));
};
