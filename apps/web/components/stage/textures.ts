import * as THREE from "three";
import type { Tone } from "./store";

/** Canvas textures for the stage, drawn locally with system fonts: no font or image downloads. */

const MONO = "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace";
export const TONE_HEX: Record<Tone, string> = {
  capture: "#7ce8c9",
  ask: "#ffc46b",
  void: "#ff2d55",
  idle: "#9be7ff",
};

/** Small deterministic PRNG, so an order's slab looks the same on every load. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (s: string) =>
  Array.from(s).reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261);

function canvasTexture(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  draw(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const W = 384;
const H = 1216;

/** The left half of a slab: what the user signed. Spec clauses as bars, a signature line at the foot. */
export function intentTexture(id: string): THREE.CanvasTexture {
  const r = rng(seedOf(id));
  return canvasTexture(W, H, (ctx) => {
    ctx.fillStyle = "rgba(155,231,255,0.9)";
    ctx.font = `600 22px ${MONO}`;
    ctx.fillText("INTENT", 36, 72);
    ctx.fillStyle = "rgba(155,231,255,0.35)";
    ctx.fillRect(36, 92, W - 72, 2);
    let y = 150;
    const clauses = ["BUDGET", "ONE-TIME", "NEW ONLY", "NO ADD-ONS", "SELLER", "CATEGORY"];
    for (const clause of clauses) {
      if (y > H - 240) break;
      ctx.fillStyle = "rgba(155,231,255,0.55)";
      ctx.font = `500 15px ${MONO}`;
      ctx.fillText(clause, 36, y);
      y += 26;
      const lines = 1 + Math.floor(r() * 3);
      for (let i = 0; i < lines; i++, y += 28) {
        const width = (i === lines - 1 ? 0.3 + r() * 0.45 : 0.75 + r() * 0.25) * (W - 72);
        ctx.fillStyle = `rgba(214,243,255,${0.32 + r() * 0.3})`;
        ctx.fillRect(36, y - 10, width, 9);
      }
      y += 34;
    }
    // the signature: a hash line and a seal
    ctx.fillStyle = "rgba(155,231,255,0.35)";
    ctx.fillRect(36, H - 150, W - 72, 1);
    ctx.font = `500 15px ${MONO}`;
    ctx.fillStyle = "rgba(155,231,255,0.8)";
    ctx.fillText("SIGNED · ED25519", 36, H - 112);
    const hex = Array.from({ length: 16 }, () => Math.floor(r() * 16).toString(16)).join("");
    ctx.fillStyle = "rgba(155,231,255,0.45)";
    ctx.fillText(hex, 36, H - 82);
  });
}

/** The right half: the order as PayPal reports it. Line items as rows; one red row per flagged line. */
export function orderTexture(id: string, flags: number, tone: Tone): THREE.CanvasTexture {
  const r = rng(seedOf(id) ^ 0x9e3779b9);
  return canvasTexture(W, H, (ctx) => {
    const hot = flags > 0 || tone === "void";
    ctx.fillStyle = hot ? "rgba(255,120,145,0.95)" : "rgba(155,231,255,0.9)";
    ctx.font = `600 22px ${MONO}`;
    ctx.fillText("ORDER", 36, 72);
    ctx.fillStyle = hot ? "rgba(255,45,85,0.5)" : "rgba(155,231,255,0.35)";
    ctx.fillRect(36, 92, W - 72, 2);
    const rows = Math.floor((H - 330) / 46);
    const red = new Set<number>();
    while (red.size < Math.min(flags, 5)) red.add(1 + Math.floor(r() * (rows - 2)));
    ctx.font = `500 16px ${MONO}`;
    for (let i = 0; i < rows; i++) {
      const y = 160 + i * 46;
      const name = 0.35 + r() * 0.35;
      const price = `${(4 + r() * 60).toFixed(2)}`;
      if (red.has(i)) {
        ctx.fillStyle = "rgba(255,45,85,0.26)";
        ctx.fillRect(28, y - 22, W - 56, 32);
        ctx.fillStyle = "rgba(255,170,185,1)";
      } else ctx.fillStyle = `rgba(214,243,255,${0.3 + r() * 0.3})`;
      ctx.fillRect(36, y - 10, name * (W - 150), 9);
      ctx.fillText(`$${price}`, W - 36 - ctx.measureText(`$${price}`).width, y);
    }
    // totals block
    ctx.fillStyle = hot ? "rgba(255,45,85,0.45)" : "rgba(155,231,255,0.35)";
    ctx.fillRect(36, H - 150, W - 72, 1);
    ctx.font = `600 18px ${MONO}`;
    ctx.fillStyle = hot ? "rgba(255,170,185,1)" : "rgba(214,243,255,0.85)";
    ctx.fillText("TOTAL", 36, H - 106);
    const total = `$${(20 + r() * 80).toFixed(2)}`;
    ctx.fillText(total, W - 36 - ctx.measureText(total).width, H - 106);
  });
}

/** A floating tag above a slab: its id and its status, lit in its tone. */
export function tagTexture(label: string, status: string, tone: Tone): THREE.CanvasTexture {
  return canvasTexture(512, 150, (ctx) => {
    const hex = TONE_HEX[tone];
    ctx.textAlign = "center";
    ctx.font = `700 52px ${MONO}`;
    ctx.fillStyle = "#e6f6ff";
    ctx.shadowColor = hex;
    ctx.shadowBlur = 18;
    ctx.fillText(label.slice(0, 14), 256, 68);
    ctx.shadowBlur = 0;
    ctx.font = `500 26px ${MONO}`;
    ctx.fillStyle = hex;
    ctx.fillText(status.toUpperCase().split("").join(" ").slice(0, 34), 256, 122);
  });
}

/** A soft round glow, used behind slabs and the gate. */
export function glowTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (ctx) => {
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, "rgba(255,255,255,0.9)");
    g.addColorStop(0.35, "rgba(255,255,255,0.25)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
  });
}
