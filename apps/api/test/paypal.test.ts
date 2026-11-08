import { describe, expect, it } from "vitest";
import { createPayPal, PayPalError, paypalRequestId, type PayPalConfig } from "../src/paypal";
import { createTokenProvider } from "../src/paypal/auth";

// A scripted fetch: each call takes the next matching response and records the request.
type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;
interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(routes: Array<[match: string, ...replies: Reply[]]>) {
  const calls: Call[] = [];
  const queues = routes.map(([match, ...replies]) => ({ match, replies }));
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const route = queues.find((q) => `${method} ${url}`.includes(q.match) && q.replies.length);
    if (!route) throw new Error(`unexpected request ${method} ${url}`);
    const reply = route.replies.length > 1 ? route.replies.shift()! : route.replies[0]!;
    if (reply instanceof Error) throw reply;
    const text = reply.body === undefined ? null : JSON.stringify(reply.body);
    return new Response(reply.status === 204 ? null : text, {
      status: reply.status,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const BASE = "https://api-m.sandbox.paypal.com";
const token = (t = "A21AAtoken", expires_in = 32400): Reply => ({
  status: 200,
  body: { access_token: t, token_type: "Bearer", expires_in, app_id: "APP-1" },
});

const money = (value: string) => ({ currency_code: "USD", value });
const order = (status: string, auth?: { id: string; status: string }) => ({
  id: "ORDER-1",
  status,
  intent: "AUTHORIZE",
  purchase_units: [
    {
      reference_id: "default",
      custom_id: "bazaar:voltra",
      amount: {
        ...money("35.63"),
        breakdown: { item_total: money("32.99"), tax_total: money("2.64") },
      },
      items: [{ name: "Voltra Hub", sku: "HUB-BEST", unit_amount: money("32.99"), quantity: "1" }],
      ...(auth ? { payments: { authorizations: [{ ...auth, amount: money("35.63") }] } } : {}),
    },
  ],
  links: [
    { href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1", rel: "payer-action" },
  ],
});

function client(f: ReturnType<typeof fakeFetch>, extra: Partial<PayPalConfig> = {}) {
  return createPayPal({
    clientId: "cid",
    clientSecret: "secret",
    baseUrl: BASE,
    fetch: f.impl,
    sleep: async () => {},
    ...extra,
  });
}

describe("OAuth token cache", () => {
  it("sends client credentials once and reuses the token", async () => {
    const f = fakeFetch([
      ["/v1/oauth2/token", token()],
      ["GET", { status: 200, body: order("APPROVED") }],
    ]);
    const pp = client(f);
    await pp.getOrder("ORDER-1");
    await pp.getOrder("ORDER-1");
    const tokenCalls = f.calls.filter((c) => c.url.endsWith("/v1/oauth2/token"));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from("cid:secret").toString("base64")}`,
    );
    expect(tokenCalls[0]!.body).toBe("grant_type=client_credentials");
    expect(tokenCalls[0]!.headers["paypal-request-id"]).toBeTruthy();
    expect(f.calls[1]!.headers.authorization).toBe("Bearer A21AAtoken");
  });

  it("is single-flight under concurrency", async () => {
    const f = fakeFetch([["/v1/oauth2/token", token()]]);
    const tp = createTokenProvider({
      clientId: "a",
      clientSecret: "b",
      baseUrl: BASE,
      fetch: f.impl,
    });
    const tokens = await Promise.all(Array.from({ length: 10 }, () => tp.getToken()));
    expect(new Set(tokens)).toEqual(new Set(["A21AAtoken"]));
    expect(f.calls).toHaveLength(1);
  });

  it("refreshes 60 s before expiry", async () => {
    let now = 0;
    const f = fakeFetch([["/v1/oauth2/token", token("first", 3600), token("second", 3600)]]);
    const tp = createTokenProvider({
      clientId: "a",
      clientSecret: "b",
      baseUrl: BASE,
      fetch: f.impl,
      now: () => now,
    });
    expect(await tp.getToken()).toBe("first");
    now = (3600 - 61) * 1000;
    expect(await tp.getToken()).toBe("first");
    now = (3600 - 59) * 1000;
    expect(await tp.getToken()).toBe("second");
    expect(f.calls).toHaveLength(2);
  });

  it("lets the next call retry after a failed refresh", async () => {
    const f = fakeFetch([["/v1/oauth2/token", new Error("ECONNRESET"), token()]]);
    const tp = createTokenProvider({
      clientId: "a",
      clientSecret: "b",
      baseUrl: BASE,
      fetch: f.impl,
    });
    await expect(tp.getToken()).rejects.toMatchObject({ code: "POI_NETWORK_ERROR" });
    expect(await tp.getToken()).toBe("A21AAtoken");
  });

  it("maps OAuth errors without leaking the secret", async () => {
    const f = fakeFetch([
      [
        "/v1/oauth2/token",
        {
          status: 401,
          body: { error: "invalid_client", error_description: "Client Authentication failed" },
        },
      ],
    ]);
    const err = await client(f)
      .getOrder("X")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({ status: 401, code: "invalid_client" });
    expect(String((err as Error).message)).not.toContain("secret");
  });
});

describe("idempotency", () => {
  it("derives a stable UUID per action + resource", () => {
    const a = paypalRequestId("authorize", "ORDER-1");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(paypalRequestId("authorize", "ORDER-1")).toBe(a);
    expect(paypalRequestId("authorize", "ORDER-2")).not.toBe(a);
    expect(paypalRequestId("void", "ORDER-1")).not.toBe(a);
  });

  it("sends PayPal-Request-Id and Prefer on every POST, and keeps the id across retries", async () => {
    const f = fakeFetch([
      ["/v1/oauth2/token", token()],
      [
        "POST",
        { status: 503 },
        new Error("socket hang up"),
        { status: 201, body: order("COMPLETED", { id: "AUTH-1", status: "CREATED" }) },
      ],
    ]);
    const res = await client(f).authorizeOrder("ORDER-1");
    expect(res.authorizationId).toBe("AUTH-1");
    const posts = f.calls.filter((c) => c.method === "POST" && c.url.includes("/authorize"));
    expect(posts).toHaveLength(3);
    for (const p of posts) {
      expect(p.headers["paypal-request-id"]).toBe(paypalRequestId("authorize", "ORDER-1"));
      expect(p.headers.prefer).toBe("return=representation");
      expect(p.headers["content-type"]).toBe("application/json");
      expect(p.body).toBe("{}");
    }
  });

  it("does not send PayPal-Request-Id on GET", async () => {
    const f = fakeFetch([
      ["/v1/oauth2/token", token()],
      ["GET", { status: 200, body: order("APPROVED") }],
    ]);
    await client(f).getOrder("ORDER-1");
    expect(f.calls[1]!.headers["paypal-request-id"]).toBeUndefined();
  });

  it("gives up after maxRetries", async () => {
    const f = fakeFetch([
      ["/v1/oauth2/token", token()],
      [
        "GET",
        { status: 500, body: { name: "INTERNAL_SERVER_ERROR", message: "x", debug_id: "d1" } },
      ],
    ]);
    await expect(client(f, { maxRetries: 1 }).getOrder("ORDER-1")).rejects.toMatchObject({
      status: 500,
      debugId: "d1",
    });
    expect(f.calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });
});

describe("error mapping", () => {
  it("maps a 422 to PayPalError with name, debug_id and details", async () => {
    const f = fakeFetch([
      ["/v1/oauth2/token", token()],
      [
        "/authorize",
        {
          status: 422,
          body: {
            name: "UNPROCESSABLE_ENTITY",
            message: "The requested action could not be performed.",
            debug_id: "f0a1b2c3",
            details: [
              { issue: "ORDER_NOT_APPROVED", description: "Payer has not yet approved the Order." },
            ],
          },
        },
      ],
      ["GET", { status: 200, body: order("PAYER_ACTION_REQUIRED") }],
    ]);
    const err = (await client(f)
      .authorizeOrder("ORDER-1")
      .catch((e: unknown) => e)) as PayPalError;
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({ status: 422, code: "UNPROCESSABLE_ENTITY", debugId: "f0a1b2c3" });
    expect(err.hasIssue("ORDER_NOT_APPROVED")).toBe(true);
    expect(err.message).toContain("ORDER_NOT_APPROVED");
  });

  it("falls back to the paypal-debug-id header", async () => {
    const f = fakeFetch([
      ["/v1/oauth2/token", token()],
      ["GET", { status: 404, headers: { "paypal-debug-id": "hdr9" } }],
    ]);
    await expect(client(f).getOrder("NOPE")).rejects.toMatchObject({
      status: 404,
      debugId: "hdr9",
    });
  });

  it("rejects PayPal responses that fail Zod validation", async () => {
    const bad = {
      ...order("APPROVED"),
      purchase_units: [{ amount: { currency_code: "USD", value: 35.63 } }],
    };
    const f = fakeFetch([
      ["/v1/oauth2/token", token()],
      ["GET", { status: 200, body: bad }],
    ]);
    await expect(client(f).getOrder("ORDER-1")).rejects.toMatchObject({
      code: "POI_INVALID_PAYPAL_RESPONSE",
    });
  });

  it("refreshes the token once on 401 from the API", async () => {
    const f = fakeFetch([
      ["/v1/oauth2/token", token("old"), token("new")],
      [
        "GET",
        { status: 401, body: { name: "AUTHENTICATION_FAILURE" } },
        { status: 200, body: order("APPROVED") },
      ],
    ]);
    await client(f).getOrder("ORDER-1");
    const gets = f.calls.filter((c) => c.method === "GET");
    expect(gets.map((g) => g.headers.authorization)).toEqual(["Bearer old", "Bearer new"]);
  });

  it("URL-encodes ids so they cannot escape the path", async () => {
    const f = fakeFetch([
      ["/v1/oauth2/token", token()],
      ["GET", { status: 200, body: order("APPROVED") }],
    ]);
    await client(f).getOrder("../../v1/reporting");
    expect(f.calls[1]!.url).toBe(`${BASE}/v2/checkout/orders/..%2F..%2Fv1%2Freporting`);
  });
});

describe("orders and payments", () => {
  it("authorize recovers an authorization made by an earlier attempt", async () => {
    const f = fakeFetch([
      ["/v1/oauth2/token", token()],
      [
        "/authorize",
        {
          status: 422,
          body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_AUTHORIZED" }] },
        },
      ],
      ["GET", { status: 200, body: order("COMPLETED", { id: "AUTH-9", status: "CREATED" }) }],
    ]);
    expect((await client(f).authorizeOrder("ORDER-1")).authorizationId).toBe("AUTH-9");
  });

  it("capture sends final_capture and its own request id", async () => {
    const f = fakeFetch([
      ["/v1/oauth2/token", token()],
      [
        "/capture",
        {
          status: 201,
          body: { id: "CAP-1", status: "COMPLETED", final_capture: true, amount: money("35.63") },
        },
      ],
    ]);
    const cap = await client(f).captureAuthorization("AUTH-1");
    expect(cap.status).toBe("COMPLETED");
    const post = f.calls.find((c) => c.url.endsWith("/v2/payments/authorizations/AUTH-1/capture"))!;
    expect(JSON.parse(post.body!)).toEqual({ final_capture: true });
    expect(post.headers["paypal-request-id"]).toBe(paypalRequestId("capture", "AUTH-1"));
  });

  it("void reads the authorization back after a 204", async () => {
    const f = fakeFetch([
      ["/v1/oauth2/token", token()],
      ["POST", { status: 204 }],
      ["GET", { status: 200, body: { id: "AUTH-1", status: "VOIDED" } }],
    ]);
    expect((await client(f).voidAuthorization("AUTH-1")).status).toBe("VOIDED");
  });

  it("void is safe to repeat on an already-voided authorization", async () => {
    const f = fakeFetch([
      ["/v1/oauth2/token", token()],
      [
        "POST",
        {
          status: 422,
          body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PREVIOUSLY_VOIDED" }] },
        },
      ],
      ["GET", { status: 200, body: { id: "AUTH-1", status: "VOIDED" } }],
    ]);
    expect((await client(f).voidAuthorization("AUTH-1")).status).toBe("VOIDED");
  });

  it("void rethrows a 422 when the authorization is not voided", async () => {
    const f = fakeFetch([
      ["/v1/oauth2/token", token()],
      [
        "POST",
        {
          status: 422,
          body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PREVIOUSLY_CAPTURED" }] },
        },
      ],
      ["GET", { status: 200, body: { id: "AUTH-1", status: "CAPTURED" } }],
    ]);
    await expect(client(f).voidAuthorization("AUTH-1")).rejects.toMatchObject({ status: 422 });
  });
});
