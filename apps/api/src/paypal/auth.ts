import { randomUUID } from "node:crypto";
import { invalidResponse, PayPalError, toPayPalError } from "./errors";
import { PayPalTokenResponse } from "./schemas";

export interface TokenProviderOptions {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  fetch?: typeof fetch;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Refresh this long before PayPal's expiry. Default 60 s. */
  refreshSkewMs?: number;
}

export interface TokenProvider {
  /** A valid access token, fetched or from cache. Never log the return value. */
  getToken(): Promise<string>;
  /** Drop the cached token (after PayPal rejects it with 401). */
  invalidate(): void;
}

/**
 * Client-credentials OAuth (POST /v1/oauth2/token). The token lives in memory until 60 s
 * before expiry. Refresh is single-flight: concurrent callers share one in-flight request,
 * so a burst of verifications at startup costs one token call, not N.
 */
export function createTokenProvider(opts: TokenProviderOptions): TokenProvider {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const skew = opts.refreshSkewMs ?? 60_000;
  const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/v1/oauth2/token`;

  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          // House rule: every PayPal POST carries one. A token request is not a business
          // action, so a fresh id per request is right (nothing to deduplicate).
          "PayPal-Request-Id": randomUUID(),
        },
        body: "grant_type=client_credentials",
      });
    } catch (err) {
      throw new PayPalError(
        0,
        "POI_NETWORK_ERROR",
        "PayPal OAuth token request failed",
        undefined,
        [],
        {
          cause: err,
        },
      );
    }
    if (!res.ok) throw await toPayPalError(res, "PayPal OAuth token request");
    const parsed = PayPalTokenResponse.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw invalidResponse("PayPal OAuth token request", parsed.error);
    cached = { token: parsed.data.access_token, expiresAt: now() + parsed.data.expires_in * 1000 };
    return cached.token;
  }

  return {
    getToken() {
      if (cached && now() < cached.expiresAt - skew) return Promise.resolve(cached.token);
      inflight ??= fetchToken().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
