/**
 * Typed fetch client for the POI API (docs/CONTRACTS.md section 3).
 * Every response is Zod-parsed, so a contract drift fails loudly at the call site.
 */
import type { z } from "zod";
import {
  ApiErrorBody,
  AuthorizeOrderResponse,
  CompileIntentResponse,
  GetIntentResponse,
  HealthResponse,
  LedgerResponse,
  MerchantsResponse,
  OkResponse,
  SignIntentResponse,
  VerificationResult,
  VerifyOrderResponse,
  VerifyRecordResponse,
  type AttachOrderRequest,
  type DecisionRequest,
  type IntentSpecInput,
  type LedgerQuery,
  type VerifyOrderRequest,
} from "./schemas";

export class PoiApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PoiApiError";
  }
}

export interface PoiClientOptions {
  /** e.g. "http://localhost:4000" -- the client adds the /api prefix. */
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export function createPoiClient(opts: PoiClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, "") + "/api";
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<S extends z.ZodTypeAny>(
    method: "GET" | "POST",
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<z.infer<S>> {
    const res = await doFetch(base + path, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new PoiApiError(res.status, "BAD_JSON", `Non-JSON response from ${method} ${path}`);
      }
    }
    if (!res.ok) {
      const err = ApiErrorBody.safeParse(json);
      if (err.success)
        throw new PoiApiError(res.status, err.data.error.code, err.data.error.message);
      throw new PoiApiError(
        res.status,
        "HTTP_ERROR",
        `${method} ${path} failed with ${res.status}`,
      );
    }
    return schema.parse(json);
  }

  const enc = encodeURIComponent;

  return {
    compileIntent: (text: string) =>
      request("POST", "/intents/compile", CompileIntentResponse, { text }),
    signIntent: (spec: IntentSpecInput) =>
      request("POST", "/intents", SignIntentResponse, { spec }),
    getIntent: (intentId: string) => request("GET", `/intents/${enc(intentId)}`, GetIntentResponse),
    attachOrder: (orderId: string, body: AttachOrderRequest) =>
      request("POST", `/orders/${enc(orderId)}/attach`, OkResponse, body),
    authorizeOrder: (orderId: string) =>
      request("POST", `/orders/${enc(orderId)}/authorize`, AuthorizeOrderResponse, {}),
    verifyOrder: (orderId: string, body: VerifyOrderRequest = { mode: "dry-run" }) =>
      request("POST", `/orders/${enc(orderId)}/verify`, VerifyOrderResponse, body),
    getVerification: (verificationId: string) =>
      request("GET", `/verifications/${enc(verificationId)}`, VerificationResult),
    decide: (verificationId: string, decision: DecisionRequest["decision"]) =>
      request("POST", `/verifications/${enc(verificationId)}/decision`, VerificationResult, {
        decision,
      }),
    getLedger: (query: LedgerQuery = {}) => {
      const qs = new URLSearchParams();
      if (query.limit !== undefined) qs.set("limit", String(query.limit));
      if (query.cursor) qs.set("cursor", query.cursor);
      if (query.mode) qs.set("mode", query.mode);
      const suffix = qs.size ? `?${qs.toString()}` : "";
      return request("GET", `/ledger${suffix}`, LedgerResponse);
    },
    getVerifyRecord: (orderId: string) =>
      request("GET", `/verify/${enc(orderId)}`, VerifyRecordResponse),
    getMerchants: () => request("GET", "/merchants", MerchantsResponse),
    health: () => request("GET", "/health", HealthResponse),

    /** Poll a verification until it is DONE or ERROR (bench, mcp). */
    async waitForVerification(
      verificationId: string,
      { intervalMs = 1000, timeoutMs = 120_000 } = {},
    ) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const v = await this.getVerification(verificationId);
        if (v.status === "DONE" || v.status === "ERROR") return v;
        if (Date.now() > deadline) {
          throw new PoiApiError(408, "TIMEOUT", `Verification ${verificationId} did not finish`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    },
  };
}

export type PoiClient = ReturnType<typeof createPoiClient>;
