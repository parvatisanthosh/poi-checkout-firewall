import type { Metadata } from "next";
import { ArenaClient } from "./arena-client";

export const metadata: Metadata = {
  title: "Arena -- POI Immune",
  description: "Adversarial MAP-Elites search exploring checkout attack genomes.",
};

export default function ArenaPage() {
  return <ArenaClient />;
}
