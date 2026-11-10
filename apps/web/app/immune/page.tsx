import type { Metadata } from "next";
import { ImmuneClient } from "./immune-client";

export const metadata: Metadata = {
  title: "Immune Memory -- POI Immune",
  description: "Learned antibody memory, structural fingerprints, and merchant risk registry.",
};

export default function ImmunePage() {
  return <ImmuneClient />;
}
