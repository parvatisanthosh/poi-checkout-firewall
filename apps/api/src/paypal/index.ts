import { env as defaultEnv, type Env } from "../env";
import { createTokenProvider } from "./auth";
import { createPayPalHttp } from "./http";
import { createOrdersApi } from "./orders";
import { createPaymentsApi } from "./payments";

export { PayPalError } from "./errors";
export { paypalRequestId, type PayPalAction } from "./idempotency";
export { approvalLink, type AuthorizeResult } from "./orders";
export { createToolkitReader, type ToolkitReader } from "./toolkit";
export * from "./schemas";

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  maxRetries?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The one PayPal client POI uses for every money action. */
export function createPayPal(config: PayPalConfig) {
  const tokens = createTokenProvider(config);
  const http = createPayPalHttp({ ...config, tokens });
  return { tokens, ...createOrdersApi(http), ...createPaymentsApi(http) };
}

export type PayPal = ReturnType<typeof createPayPal>;

export function paypalConfigFromEnv(e: Env = defaultEnv): PayPalConfig {
  if (!e.PAYPAL_CLIENT_ID || !e.PAYPAL_CLIENT_SECRET) {
    throw new Error(
      "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in .env (developer.paypal.com > Apps & Credentials, sandbox).",
    );
  }
  return {
    clientId: e.PAYPAL_CLIENT_ID,
    clientSecret: e.PAYPAL_CLIENT_SECRET,
    baseUrl: e.PAYPAL_BASE_URL,
  };
}

export function paypalFromEnv(e: Env = defaultEnv): PayPal {
  return createPayPal(paypalConfigFromEnv(e));
}
