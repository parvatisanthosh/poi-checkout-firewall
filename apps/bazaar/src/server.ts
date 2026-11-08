import cors from "cors";
import express from "express";
import type { ListingCard } from "@poi/shared";

// Hello-world skeleton for the Adversarial Bazaar (task F1, owned by the teammate).
// See docs/CONTRACTS.md section 4 for the full API.
const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/catalog", (_req, res) => {
  const listings: ListingCard[] = [];
  res.json(listings);
});

const port = Number(process.env.BAZAAR_PORT ?? 4100);
app.listen(port, () => {
  console.log(`[bazaar] Adversarial Bazaar on http://localhost:${port}`);
});
