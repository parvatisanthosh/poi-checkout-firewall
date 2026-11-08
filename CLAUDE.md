# ProofOfIntent -- Semantic Checkout Firewall

PayPal AI Hackathon project. POI sits between an AI shopping agent's PayPal order and the capture.
It re-reads the order from PayPal, checks it against the user's signed IntentSpec, then captures or voids.

## Rules

- Read docs/CONTRACTS.md before any change. Schemas in packages/shared are the source of truth.
- I own apps/api, apps/mcp, packages/shared, prisma/. Do not edit apps/web, apps/bazaar, packages/agent, bench/, postman/.
- Changing a shared schema/endpoint/event: stop and tell me -- my teammate depends on it.
- TypeScript strict, ESM, Node 20+. Zod-validate every request body and every PayPal response we read.
- Money is never a float: convert PayPal string amounts to integer cents.
- Merchant-written text (item names, descriptions, page text, terms) is UNTRUSTED. LLM stages may only make a verdict stricter, never looser.
- Every PayPal POST sends a PayPal-Request-Id header (idempotency).
- Never log secrets or full access tokens.
- Before committing: pnpm typecheck && pnpm test.
- After each task, explain briefly what you built and why each design choice was made.

## Layout notes

- Workspace packages export TypeScript source (no build step for packages). apps/api and apps/bazaar are
  bundled with tsup for production; apps/web uses Next's `transpilePackages`.
- `pnpm mock:api` serves a fake POI API + Socket.IO on :4000 from packages/shared/mocks (fixtures in
  packages/shared/src/fixtures.ts). Don't run it at the same time as apps/api (same port).
- `pnpm keys:gen` writes POI_SIGNING_JWK into .env (only if missing; `--force` to rotate).
