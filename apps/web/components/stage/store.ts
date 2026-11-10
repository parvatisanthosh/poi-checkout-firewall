import { useSyncExternalStore } from "react";

/**
 * What the pages tell the 3D stage behind them. The scene reads this object every frame, so most writes are
 * plain assignments and cost no React render; only a change to what is on stage (mode, slabs, crystals,
 * pausing) re-renders the scene.
 */

export type Tone = "capture" | "ask" | "void" | "idle";

/** One order on stage: a glass slab, signed INTENT on the left, the ORDER PayPal reports on the right. */
export interface StageSlab {
  id: string;
  label: string;
  status: string;
  tone: Tone;
  /** 0..1: how far the order strays from the intent. The halves pull apart and the links break. */
  mismatch: number;
  /** Lines POI flagged: red rows on the order face. */
  flags: number;
}

/**
 * story    -- the home page's scroll story (stage.story = step)
 * gate     -- the firewall with orders flowing through it
 * docket   -- a row of real orders (the ledger)
 * focus    -- one order brought forward and split (verify, a live verdict)
 * swarm    -- evolved attacks circling the gate (the arena)
 * crystals -- learned antibodies orbiting the gate (immune memory)
 * ambient  -- the gate at rest, pushed back behind dense pages
 */
export type StageMode = "story" | "gate" | "docket" | "focus" | "swarm" | "crystals" | "ambient";

export const stage = {
  mode: "gate" as StageMode,
  slabs: [] as StageSlab[],
  /** The slab brought forward in focus mode. */
  focus: null as string | null,
  /** A slab the pointer is over (docket): it lifts and brightens. */
  hover: null as string | null,
  /** Home page scroll story step, 0..5. */
  story: 0,
  /** performance.now() of the last VOID: the red shock. 0 = never. */
  haltAt: 0,
  /** performance.now() of the last CAPTURE: a mint pulse through the gate. */
  passAt: 0,
  /** Arena: share of attacks that fooled POI-static, and POI-immune. */
  swarm: { count: 36, fooledStatic: 0.4, fooledImmune: 0.1 },
  /** Immune memory: antibodies by state. */
  crystals: { active: 6, candidate: 2, retired: 1 },
  paused: false,
};

let version = 0;
const listeners = new Set<() => void>();
const RERENDER = new Set(["mode", "slabs", "crystals", "paused", "story"]);

export function setStage(patch: Partial<typeof stage>): void {
  const rerender = Object.keys(patch).some(
    (k) => RERENDER.has(k) && patch[k as keyof typeof stage] !== stage[k as keyof typeof stage],
  );
  Object.assign(stage, patch);
  if (rerender) {
    version++;
    listeners.forEach((l) => l());
  }
}

/** The red shock and the full-screen sweep (a VOID). */
export function haltNow(): void {
  stage.haltAt = performance.now();
  window.dispatchEvent(new Event("poi:halt"));
}

/** A mint pulse through the gate (a CAPTURE). */
export function passNow(): void {
  stage.passAt = performance.now();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Re-renders the caller when what is on stage changes. */
export function useStageVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}

export const toneOfVerdict = (v?: string | null): Tone =>
  v === "CAPTURE" ? "capture" : v === "VOID" ? "void" : v === "ASK_HUMAN" ? "ask" : "idle";
