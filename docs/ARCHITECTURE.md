# Architecture

POI is one Express API plus one BullMQ worker, sitting between the merchant's PayPal order and the
PayPal capture. Everything else exists to attack it, drive it or show it.

## Live flow

1. **Web -> POI** `POST /intents/compile`: text becomes a draft IntentSpec plus ambiguities. The user
   answers, confirms, and `POST /intents` signs it (EdDSA JWS over the RFC 8785 canonical spec hash).
2. **Web -> Agent**: the agent gets the user's original text (not the spec) and shops the Bazaar.
3. **Agent -> Bazaar** `POST /checkout`: the Bazaar, acting as the merchant, creates a PayPal order with
   `intent: AUTHORIZE`. Poisoned listings inject their hidden lines here.
4. **Web -> PayPal**: the JS SDK button (`intent=authorize`) shows the sandbox approval popup.
5. **Web -> POI** `POST /orders/:id/authorize`: POI authorizes (a hold, no money moves) and enqueues a
   verify job.
6. **Worker**: re-reads the order from PayPal, runs deterministic diff -> look-alike -> [semantic judge,
   terms RAG, shadow run] and streams each check over Socket.IO.
7. **Verdict** (lattice, LLM stages can only tighten): CAPTURE, VOID, or ASK_HUMAN. Every PayPal POST
   carries a deterministic `PayPal-Request-Id`.
8. **Evidence**: intent, order snapshot, checks and verdict are canonicalized, hash-chained and signed.
   `GET /verify/:orderId` re-validates the chain.
9. **Webhooks** confirm the final PayPal state.

_Diagram and per-stage details are added on Day 4._
