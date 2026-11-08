# ProofOfIntent -- Semantic Checkout Firewall

> Signed mandates prove you said yes. ProofOfIntent proves the agent bought what you meant.

ProofOfIntent (POI) is a semantic checkout firewall for AI shopping agents on PayPal. The merchant creates
a PayPal order with `intent: AUTHORIZE`; POI places the hold, re-reads the real order from PayPal, checks
it against the user's signed intent, and then **captures**, **voids** or **asks the human**.

_Built for the PayPal AI Hackathon (Nov 2026). Headline numbers, demo link and video: coming soon._

## Quick start (local)

Prerequisites: Node 20+ (22 recommended), pnpm 10 (`npm install -g pnpm@10`), Docker.

```bash
pnpm install
cp .env.example .env      # then fill in PayPal sandbox + LLM keys
pnpm keys:gen             # writes POI_SIGNING_JWK into .env
docker compose up -d      # Postgres 16 + pgvector, Redis 7
pnpm dev                  # web :3000, api :4000, bazaar :4100
```

Working on the web app or Bazaar before the real API is ready? Use the mock instead:

```bash
pnpm dev:mock             # web + bazaar + mock POI API on :4000
curl http://localhost:4000/api/verifications/demo
```

## Repo layout

| Path               | What                                              | Owner    |
| ------------------ | ------------------------------------------------- | -------- |
| `apps/api`         | POI Express API + BullMQ worker (the firewall)    | Parvati  |
| `apps/mcp`         | MCP server wrapping the POI API                   | Parvati  |
| `packages/shared`  | Zod contracts, socket events, API client, mock    | Parvati  |
| `prisma/`          | Database schema, migrations, seed                 | Parvati  |
| `apps/bazaar`      | Adversarial Bazaar merchant service               | Teammate |
| `apps/web`         | Next.js app: shop flow, scorecard, ledger, verify | Teammate |
| `packages/agent`   | Shopping agent (Vercel AI SDK)                    | Teammate |
| `bench/`           | IntentBench-mini runner and results               | Teammate |

Contracts between the halves: [docs/CONTRACTS.md](docs/CONTRACTS.md).

## Scripts

| Command           | What it does                                         |
| ----------------- | ---------------------------------------------------- |
| `pnpm dev`        | Run every app in watch mode                          |
| `pnpm dev:mock`   | Run everything except the real API, plus the mock    |
| `pnpm mock:api`   | Mock POI API + Socket.IO on :4000                    |
| `pnpm typecheck`  | Type-check every workspace                           |
| `pnpm test`       | Run all tests (vitest)                               |
| `pnpm lint`       | ESLint + Prettier check                              |
| `pnpm keys:gen`   | Generate the Ed25519 signing key into `.env`         |
| `pnpm paypal:smoke` | Sandbox order -> approve -> authorize -> void (`-- --capture` to capture) |

## Real vs simulated

- **Real:** PayPal sandbox orders, authorizations, captures and voids.
- **Simulated:** the Bazaar's merchants all share one PayPal sandbox business account (POI tells them
  apart via `purchase_units[0].custom_id = "bazaar:<merchantId>"`); attacks were written by the team.

## License

[MIT](LICENSE)
