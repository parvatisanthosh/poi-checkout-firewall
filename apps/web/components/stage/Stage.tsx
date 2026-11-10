"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { setStage, useStageVersion, stage, type StageMode } from "./store";

// three.js is loaded only when the scene will really run
const StageCanvas = dynamic(() => import("./StageCanvas"), { ssr: false });

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** The scene each route starts in. Pages refine it (ledger rows, the verified order, arena numbers). */
export function modeFor(pathname: string | null): StageMode {
  if (!pathname || pathname === "/") return "story";
  if (pathname.startsWith("/shop")) return "gate";
  if (pathname.startsWith("/ledger")) return "docket";
  if (pathname.startsWith("/verify/")) return "focus";
  if (pathname.startsWith("/arena")) return "swarm";
  if (pathname.startsWith("/immune")) return "crystals";
  return "ambient";
}

/**
 * The world behind every page. It keeps the 3D firewall in step with the route and plays the red sweep when an
 * order is voided. With reduced motion, or without WebGL, only the still backdrop shows: every page works the
 * same without the scene.
 */
export function Stage() {
  const pathname = usePathname();
  const [mode, setMode] = useState<"pending" | "3d" | "static">("pending");
  const [sweep, setSweep] = useState(0);
  useStageVersion();

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const decide = () => setMode(!reduced.matches && hasWebGL() ? "3d" : "static");
    decide();
    reduced.addEventListener("change", decide);
    return () => reduced.removeEventListener("change", decide);
  }, []);

  // Only the mode: a page's own effects run before this one (child first) and own slabs and focus.
  useEffect(() => {
    setStage({ mode: modeFor(pathname), hover: null, story: 0 });
  }, [pathname]);

  useEffect(() => {
    const onHalt = () => setSweep((n) => n + 1);
    window.addEventListener("poi:halt", onHalt);
    return () => window.removeEventListener("poi:halt", onHalt);
  }, []);

  return (
    <>
      <div
        aria-hidden
        data-print="hidden"
        className="stage-static pointer-events-none fixed inset-0 -z-20"
      >
        {mode === "static" && (
          <div className="grid-floor absolute bottom-[-18%] left-[-30%] h-[48%] w-[160%] opacity-50" />
        )}
      </div>
      {mode === "3d" && (
        <div
          aria-hidden
          data-print="hidden"
          className={`pointer-events-none fixed inset-0 -z-10 transition-opacity duration-700 ${
            stage.paused ? "opacity-0" : ""
          }`}
        >
          <StageCanvas />
        </div>
      )}
      {sweep > 0 && <div key={sweep} aria-hidden className="halt-sweep" />}
    </>
  );
}
