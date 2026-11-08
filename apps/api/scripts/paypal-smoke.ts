// pnpm paypal:smoke [--capture] [--order <orderId>]
//
// End-to-end check against the PayPal sandbox:
//   1. creates an AUTHORIZE order (as a Bazaar merchant would) and prints the approval link
//   2. waits while you approve it in a browser with the sandbox *buyer* account
//   3. authorizes (places the hold), then voids it (or captures it with --capture)
//   4. reads the authorization back and prints the final status
// Pass --order to resume an order you already created/approved.
import { randomUUID } from "node:crypto";
import { env } from "../src/env";
import { approvalLink, PayPalError, paypalFromEnv, type PayPalOrder } from "../src/paypal";

const args = process.argv.slice(2);
const capture = args.includes("--capture");
const orderArg = args.includes("--order") ? args[args.indexOf("--order") + 1] : undefined;
const POLL_MS = 3_000;
const TIMEOUT_MS = 15 * 60_000;

const log = (step: string, detail = "") =>
  console.log(`${new Date().toISOString().slice(11, 19)}  ${step.padEnd(12)} ${detail}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForApproval(
  pp: ReturnType<typeof paypalFromEnv>,
  orderId: string,
): Promise<PayPalOrder> {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = "";
  for (;;) {
    const order = await pp.getOrder(orderId);
    if (order.status !== last) log("order", `status ${order.status}`);
    last = order.status;
    if (order.status === "APPROVED" || order.status === "COMPLETED") return order;
    if (order.status === "VOIDED") throw new Error("order was voided/cancelled before approval");
    if (Date.now() > deadline) throw new Error("timed out waiting for buyer approval");
    await sleep(POLL_MS);
  }
}

async function main() {
  const pp = paypalFromEnv();
  log("env", `${env.PAYPAL_BASE_URL} (client ${env.PAYPAL_CLIENT_ID?.slice(0, 6)}...)`);

  await pp.tokens.getToken();
  log("oauth", "token ok");

  let orderId = orderArg;
  if (!orderId) {
    const order = await pp.createOrder(
      {
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: "smoke",
            custom_id: "bazaar:smoke",
            description: "ProofOfIntent smoke test",
            amount: {
              currency_code: "USD",
              value: "35.63",
              breakdown: {
                item_total: { currency_code: "USD", value: "32.99" },
                tax_total: { currency_code: "USD", value: "2.64" },
              },
            },
            items: [
              {
                name: "Voltra USB-C Hub 7-in-1 (smoke test)",
                sku: "HUB-BEST",
                unit_amount: { currency_code: "USD", value: "32.99" },
                quantity: "1",
                category: "PHYSICAL_GOODS",
              },
            ],
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: "POI Smoke Test",
              user_action: "CONTINUE",
              shipping_preference: "NO_SHIPPING",
              return_url: `${env.WEB_ORIGIN}/?smoke=approved`,
              cancel_url: `${env.WEB_ORIGIN}/?smoke=cancelled`,
            },
          },
        },
      },
      { reference: `smoke-${randomUUID()}` },
    );
    orderId = order.id;
    log("create", `order ${order.id}, status ${order.status}, intent ${order.intent}`);
    console.log(
      `\n  Approve with the sandbox BUYER account:\n  ${approvalLink(order) ?? "(no approval link returned)"}\n`,
    );
    console.log(
      "  (After approving, PayPal redirects to WEB_ORIGIN; if nothing runs there, just close the tab.)\n",
    );
  }

  await waitForApproval(pp, orderId);

  const { authorizationId, authorization } = await pp.authorizeOrder(orderId);
  log(
    "authorize",
    `authorization ${authorizationId}, status ${authorization.status}, expires ${authorization.expiration_time ?? "?"}`,
  );

  if (capture) {
    const cap = await pp.captureAuthorization(authorizationId);
    log("capture", `capture ${cap.id}, status ${cap.status}`);
  } else {
    const voided = await pp.voidAuthorization(authorizationId);
    log("void", `status ${voided.status}`);
  }

  const final = await pp.getAuthorization(authorizationId);
  log("final", `authorization ${final.id} is ${final.status}`);
  const expected = capture ? "CAPTURED" : "VOIDED";
  if (final.status !== expected) {
    console.error(`\nExpected ${expected}, got ${final.status}`);
    process.exit(1);
  }
  console.log(
    `\nDone: authorization ${authorizationId} is ${expected}. Check it in the sandbox dashboard.`,
  );
}

main().catch((err: unknown) => {
  if (err instanceof PayPalError) {
    console.error(
      `\nPayPal error: ${err.message}${err.debugId ? ` (debug_id ${err.debugId})` : ""}`,
    );
  } else {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
});
