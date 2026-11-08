import type { z } from "zod";
import type { TokenProvider } from "./auth";
import { invalidResponse, PayPalError, toPayPalError } from "./errors";

/** A POST body sent verbatim instead of JSON.stringify-ed (webhook verification needs the original bytes). */
export class RawJson {
  constructor(readonly text: string) {}
}

export interface PayPalHttpOptions {
  baseUrl: string;
  tokens: TokenProvider;
  fetch?: typeof fetch;
  /** Retries for network errors, 429 and 5xx. Default 2. Safe for POSTs because of PayPal-Request-Id. */
  maxRetries?: number;
  /** Base backoff; attempt n waits base * 2^n. Default 300 ms. */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface GetRequest<T> {
  path: string;
  schema: z.ZodType<T>;
  what: string;
}

export interface PostRequest<T> extends GetRequest<T> {
  body: unknown;
  /** Required: every PayPal POST is idempotency-keyed. */
  requestId: string;
}

export interface PayPalHttp {
  get<T>(req: GetRequest<T>): Promise<T>;
  /** Resolves `undefined` when PayPal answers 204 No Content (e.g. void without a body). */
  post<T>(req: PostRequest<T>): Promise<T | undefined>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createPayPalHttp(opts: PayPalHttpOptions): PayPalHttp {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const maxRetries = opts.maxRetries ?? 2;
  const delay = opts.retryDelayMs ?? 300;
  const sleep = opts.sleep ?? defaultSleep;

  async function send(
    method: "GET" | "POST",
    path: string,
    what: string,
    post?: { body: unknown; requestId: string },
  ): Promise<unknown> {
    let retries = 0;
    let reauthed = false;
    for (;;) {
      const token = await opts.tokens.getToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };
      if (post) {
        headers["Content-Type"] = "application/json";
        headers["PayPal-Request-Id"] = post.requestId;
        headers.Prefer = "return=representation";
      }

      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers,
          body: post
            ? post.body instanceof RawJson
              ? post.body.text
              : JSON.stringify(post.body ?? {})
            : undefined,
        });
      } catch (err) {
        if (retries < maxRetries) {
          await sleep(delay * 2 ** retries++);
          continue;
        }
        throw new PayPalError(
          0,
          "POI_NETWORK_ERROR",
          `${what} failed: network error`,
          undefined,
          [],
          {
            cause: err,
          },
        );
      }

      // Token expired or revoked server-side before our cache noticed: refresh once.
      if (res.status === 401 && !reauthed) {
        reauthed = true;
        opts.tokens.invalidate();
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && retries < maxRetries) {
        await sleep(delay * 2 ** retries++);
        continue;
      }
      if (!res.ok) throw await toPayPalError(res, what);

      const text = await res.text();
      if (!text) return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch (err) {
        throw invalidResponse(what, err as Error);
      }
    }
  }

  function parse<T>(schema: z.ZodType<T>, json: unknown, what: string): T {
    const r = schema.safeParse(json);
    if (!r.success) throw invalidResponse(what, r.error);
    return r.data;
  }

  return {
    async get(req) {
      return parse(req.schema, await send("GET", req.path, req.what), req.what);
    },
    async post(req) {
      const json = await send("POST", req.path, req.what, {
        body: req.body,
        requestId: req.requestId,
      });
      return json === undefined ? undefined : parse(req.schema, json, req.what);
    },
  };
}
