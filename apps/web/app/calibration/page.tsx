import type { Metadata } from "next";
import { CalibrationClient } from "./calibration-client";

export const metadata: Metadata = {
  title: "Calibration -- POI Immune",
  description: "Conformal Risk Control calibration dashboard and error rate bounds.",
};

export default function CalibrationPage() {
  return <CalibrationClient />;
}

