import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "dotenv";
import { createBazaarApp } from "./app";
import { loadData } from "./data";
import { createMerchantPayPal } from "./paypal";

// Find the repo-root .env from wherever we are started.
for (let dir = process.cwd(); ; dir = dirname(dir)) {
  if (existsSync(join(dir, ".env"))) {
    config({ path: join(dir, ".env"), quiet: true });
    break;
  }
  if (dirname(dir) === dir) break;
}

const data = loadData();
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
const paypal =
  PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET
    ? createMerchantPayPal({
        clientId: PAYPAL_CLIENT_ID,
        clientSecret: PAYPAL_CLIENT_SECRET,
        baseUrl: process.env.PAYPAL_BASE_URL ?? "https://api-m.sandbox.paypal.com",
      })
    : undefined;

const app = createBazaarApp({
  data,
  paypal,
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
});
const port = Number(process.env.PORT ?? process.env.BAZAAR_PORT ?? 4100);
app.listen(port, () => {
  console.log(
    `[bazaar] Adversarial Bazaar on http://localhost:${port} -- ${data.products.length} listings, ${data.scenarios.length} scenarios, PayPal ${paypal ? "on" : "OFF (checkout returns 503)"}`,
  );
});
