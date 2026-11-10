"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Lightformer, PerformanceMonitor } from "@react-three/drei";
import {
  Bloom,
  ChromaticAberration,
  EffectComposer,
  Noise,
  Vignette,
} from "@react-three/postprocessing";
import { stage, useStageVersion, type StageSlab } from "./store";
import { glowTexture, intentTexture, orderTexture, tagTexture, TONE_HEX } from "./textures";

/**
 * The firewall: one scene behind every page. A ring of light is the gate between an AI agent's order and the
 * money. Each order is a slab of dark glass in two halves -- the INTENT the user signed and the ORDER PayPal
 * reports -- joined by links. Orders that match pass through the gate in a mint pulse; orders that don't stop
 * short, split apart as their links break, and a red shock goes out. Pages drive it through ./store; nothing
 * here reads React state per frame.
 */

const HALF_W = 0.74;
const SLAB_H = 2.3;
const DEPTH = 0.14;
const STRANDS = 10;
const GATE_R = 2.05;
const GATE_YAW = 0.62; // the gate faces back-left -> front-right
const ICE = new THREE.Color("#9be7ff");
const RED = new THREE.Color("#ff2d55");
const MINT = new THREE.Color("#7ce8c9");
const AMBER = new THREE.Color("#ffc46b");
const damp = THREE.MathUtils.damp;
/** The way orders travel: through the gate, along its normal. */
const DIR = new THREE.Vector3(Math.sin(GATE_YAW), 0, Math.cos(GATE_YAW));

/** Pointer and scroll, read from the window: the canvas sits behind the page and gets no events. */
const input = { px: 0, py: 0, scroll: 0 };

function useWindowInput(): void {
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      input.px = (e.clientX / window.innerWidth) * 2 - 1;
      input.py = (e.clientY / window.innerHeight) * 2 - 1;
    };
    const onScroll = () => {
      input.scroll = window.scrollY / Math.max(window.innerHeight, 1);
    };
    onScroll();
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
}

/** Shared gate state: where it is (follows the mode), how lit, and its last pulse (-1 red .. +1 mint). */
const gate = { pos: new THREE.Vector3(2.3, 0.1, 0), scale: 1, dim: 1, pulse: 0, scan: 0 };

const since = (at: number) => (at ? (performance.now() - at) / 1000 : Infinity);
const halting = () => since(stage.haltAt) < 2.6 || (stage.mode === "story" && stage.story === 4);

function gateTarget(narrow: boolean) {
  const x = (d: number) => (narrow ? 0 : d);
  switch (stage.mode) {
    case "story":
      return { p: [x(2.4), narrow ? 1.2 : 0.15, 0], scale: narrow ? 0.62 : 1, dim: 1 };
    case "gate":
      return { p: [x(2.6), narrow ? 1.5 : 0.2, -0.6], scale: narrow ? 0.6 : 1, dim: 1 };
    case "docket":
      return { p: [0, 0.9, -8], scale: 1.6, dim: 0.45 };
    case "focus":
      return { p: [x(2.9), narrow ? 1.6 : 0.95, -2.6], scale: narrow ? 0.7 : 1, dim: 0.75 };
    case "swarm":
    case "crystals":
      return { p: [x(2.6), narrow ? 1.4 : 0.25, -0.8], scale: narrow ? 0.6 : 0.95, dim: 0.9 };
    default:
      return { p: [x(3), narrow ? 1.6 : 0.5, -3.5], scale: narrow ? 0.7 : 1, dim: 0.55 };
  }
}

// ---------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------

function Gate() {
  const group = useRef<THREE.Group>(null!);
  const segs = useRef<THREE.Group>(null!);
  const glowTex = useMemo(() => glowTexture(), []);
  useEffect(() => () => glowTex.dispose(), [glowTex]);

  const mats = useMemo(
    () => ({
      ring: new THREE.MeshBasicMaterial({
        color: ICE.clone(),
        toneMapped: false,
        transparent: true,
      }),
      thin: new THREE.MeshBasicMaterial({
        color: ICE.clone(),
        toneMapped: false,
        transparent: true,
      }),
      seg: new THREE.MeshBasicMaterial({
        color: ICE.clone(),
        toneMapped: false,
        transparent: true,
      }),
      glow: new THREE.MeshBasicMaterial({
        map: glowTex,
        color: ICE.clone(),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.35,
      }),
    }),
    [glowTex],
  );
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  const membrane = useMemo(
    () => ({
      uTime: { value: 0 },
      uColor: { value: ICE.clone() },
      uScan: { value: 0 },
      uOpacity: { value: 1 },
    }),
    [],
  );

  const SEGMENTS = 56;
  const segGeo = useMemo(() => new THREE.BoxGeometry(0.16, 0.02, 0.02), []);
  useEffect(() => () => segGeo.dispose(), [segGeo]);
  const color = useMemo(() => new THREE.Color(), []);

  useFrame((state, delta) => {
    const narrow = state.size.width < 1024;
    const tgt = gateTarget(narrow);
    gate.pos.x = damp(gate.pos.x, tgt.p[0]!, 2.4, delta);
    gate.pos.y = damp(gate.pos.y, tgt.p[1]!, 2.4, delta);
    gate.pos.z = damp(gate.pos.z, tgt.p[2]!, 2.4, delta);
    gate.scale = damp(gate.scale, tgt.scale, 2.4, delta);
    gate.dim = damp(gate.dim, tgt.dim, 2.4, delta);
    gate.pulse = damp(gate.pulse, 0, 1.6, delta);
    const scanTarget =
      stage.mode === "story" && stage.story === 3 ? 1 : stage.mode === "focus" ? 0.45 : 0.15;
    gate.scan = damp(gate.scan, scanTarget, 2, delta);

    const g = group.current;
    g.position.copy(gate.pos);
    g.scale.setScalar(gate.scale);
    g.rotation.y = damp(g.rotation.y, GATE_YAW + input.px * 0.08, 2.5, delta);
    g.rotation.x = damp(g.rotation.x, input.py * 0.05, 2.5, delta);
    segs.current.rotation.z += delta * 0.12;

    const t = state.clock.elapsedTime;
    if (halting()) color.copy(RED);
    else if (gate.pulse > 0.02) color.copy(ICE).lerp(MINT, Math.min(1, gate.pulse));
    else if (gate.pulse < -0.02) color.copy(ICE).lerp(RED, Math.min(1, -gate.pulse));
    else color.copy(ICE);
    const breathe = 0.85 + 0.15 * Math.sin(t * 1.3);
    const lit = gate.dim * breathe;
    mats.ring.color.copy(color);
    mats.ring.opacity = Math.min(1, 1.1 * lit);
    mats.thin.color.copy(color);
    mats.thin.opacity = 0.45 * lit;
    mats.seg.color.copy(color);
    mats.seg.opacity = 0.7 * lit;
    mats.glow.color.copy(color);
    mats.glow.opacity = (0.18 + 0.25 * Math.abs(gate.pulse) + 0.15 * gate.scan) * gate.dim;
    membrane.uTime.value = t;
    membrane.uColor.value.copy(color);
    membrane.uScan.value = gate.scan + Math.abs(gate.pulse) * 0.6;
    membrane.uOpacity.value = gate.dim;
  });

  return (
    <group ref={group}>
      <mesh position={[0, 0, -0.4]} scale={[7.5, 7.5, 1]} material={mats.glow}>
        <planeGeometry />
      </mesh>
      <mesh material={mats.ring}>
        <torusGeometry args={[GATE_R, 0.024, 12, 160]} />
      </mesh>
      <mesh material={mats.thin}>
        <torusGeometry args={[GATE_R + 0.16, 0.006, 6, 160]} />
      </mesh>
      <group ref={segs}>
        {Array.from({ length: SEGMENTS }, (_, i) => {
          const a = (i / SEGMENTS) * Math.PI * 2;
          const r = GATE_R + 0.36;
          return (
            <mesh
              key={i}
              geometry={segGeo}
              material={mats.seg}
              position={[Math.cos(a) * r, Math.sin(a) * r, 0]}
              rotation={[0, 0, a + Math.PI / 2]}
              scale={i % 7 === 0 ? [2.2, 1.6, 1] : [1, 1, 1]}
            />
          );
        })}
      </group>
      <mesh>
        <circleGeometry args={[GATE_R - 0.02, 96]} />
        <shaderMaterial
          uniforms={membrane}
          transparent
          depthWrite={false}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
          vertexShader={`
            varying vec2 vUv;
            varying vec2 vPos;
            void main() {
              vUv = uv;
              vPos = position.xy;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `}
          fragmentShader={`
            uniform float uTime;
            uniform vec3 uColor;
            uniform float uScan;
            uniform float uOpacity;
            varying vec2 vUv;
            varying vec2 vPos;
            void main() {
              float r = length(vPos) / ${GATE_R.toFixed(2)};
              float edge = smoothstep(0.55, 1.0, r);
              float rings = 0.5 + 0.5 * sin(r * 38.0 - uTime * 1.6);
              vec2 g = abs(fract(vPos * 3.2) - 0.5);
              float grid = smoothstep(0.47, 0.5, max(g.x, g.y));
              float band = exp(-pow((vPos.y - (fract(uTime * 0.18) * 4.4 - 2.2)) * 3.2, 2.0));
              float a = edge * (0.05 + 0.05 * rings) + grid * 0.025 + band * (0.03 + 0.22 * uScan);
              a *= (1.0 - smoothstep(0.98, 1.0, r));
              gl_FragColor = vec4(uColor, a * uOpacity);
            }
          `}
        />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// A slab: one order. Pages and the flow decide where it goes; the mesh damps toward that.
// ---------------------------------------------------------------------------------------------

interface SlabDrive {
  x: number;
  y: number;
  z: number;
  ry: number;
  scale: number;
  /** 0 = halves together; grows with the mismatch. */
  gap: number;
  bright: number;
  alpha: number;
  tag: number;
  sealed: boolean;
  /** Seconds since this slab's shock started, or -1. */
  shock: number;
  /** Place exactly (the flow) instead of easing there. */
  snap?: boolean;
}

function Slab({
  slab,
  drive,
}: {
  slab: StageSlab;
  drive: (t: number, narrow: boolean, aspect: number) => SlabDrive;
}) {
  const group = useRef<THREE.Group>(null!);
  const left = useRef<THREE.Group>(null!);
  const right = useRef<THREE.Group>(null!);
  const stubs = useRef<THREE.Mesh[]>([]);
  const seal = useRef<THREE.Mesh>(null!);
  const shock = useRef<THREE.Mesh>(null!);
  const cur = useRef({ gap: 0.03, bright: 1, alpha: 0, tag: 0 });

  const tone = useMemo(() => new THREE.Color(TONE_HEX[slab.tone]), [slab.tone]);
  const tex = useMemo(
    () => ({
      intent: intentTexture(slab.id),
      order: orderTexture(slab.id, slab.flags, slab.tone),
      tag: tagTexture(slab.label, slab.status, slab.tone),
      glow: glowTexture(),
    }),
    [slab.id, slab.flags, slab.tone, slab.label, slab.status],
  );
  useEffect(() => () => Object.values(tex).forEach((t) => t.dispose()), [tex]);

  const mats = useMemo(() => {
    const body = () =>
      new THREE.MeshPhysicalMaterial({
        color: "#0a1826",
        roughness: 0.16,
        metalness: 0.55,
        clearcoat: 1,
        clearcoatRoughness: 0.1,
        envMapIntensity: 1.3,
        transparent: true,
        opacity: 0.6,
      });
    const face = (map: THREE.Texture) =>
      new THREE.MeshBasicMaterial({
        map,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        blending: THREE.AdditiveBlending,
      });
    const line = (color: THREE.Color) =>
      new THREE.LineBasicMaterial({ color, transparent: true, toneMapped: false });
    return {
      bodyL: body(),
      bodyR: body(),
      faceL: face(tex.intent),
      faceR: face(tex.order),
      edgeL: line(ICE.clone()),
      edgeR: line(tone.clone()),
      tag: new THREE.MeshBasicMaterial({
        map: tex.tag,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
      glow: new THREE.MeshBasicMaterial({
        map: tex.glow,
        color: tone,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      }),
      strand: new THREE.MeshBasicMaterial({ color: ICE, transparent: true, toneMapped: false }),
      broken: new THREE.MeshBasicMaterial({ color: RED, transparent: true, toneMapped: false }),
      seal: new THREE.MeshBasicMaterial({
        color: RED,
        transparent: true,
        toneMapped: false,
        opacity: 0,
      }),
      shock: new THREE.MeshBasicMaterial({
        color: RED,
        transparent: true,
        toneMapped: false,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    };
  }, [tex, tone]);
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  const geo = useMemo(() => {
    const box = new THREE.BoxGeometry(HALF_W, SLAB_H, DEPTH);
    return {
      box,
      edges: new THREE.EdgesGeometry(box),
      face: new THREE.PlaneGeometry(HALF_W * 0.9, SLAB_H * 0.95),
      stub: new THREE.BoxGeometry(1, 0.014, 0.014),
    };
  }, []);
  useEffect(() => () => Object.values(geo).forEach((g) => g.dispose()), [geo]);

  const brokenCount = Math.round(slab.mismatch * STRANDS);

  useFrame((state, delta) => {
    const c = cur.current;
    const t = state.clock.elapsedTime;
    const d = drive(t, state.size.width < 1024, state.size.width / state.size.height);
    const g = group.current;
    if (d.snap) {
      g.position.set(d.x, d.y, d.z);
      g.scale.setScalar(d.scale);
    } else {
      g.position.x = damp(g.position.x, d.x, 3.2, delta);
      g.position.y = damp(g.position.y, d.y, 3.2, delta);
      g.position.z = damp(g.position.z, d.z, 3.2, delta);
      g.scale.setScalar(damp(g.scale.x, d.scale, 3.2, delta));
    }
    g.rotation.y = damp(g.rotation.y, d.ry, 3, delta);
    g.rotation.x = damp(g.rotation.x, input.py * 0.06, 3, delta);

    c.gap = damp(c.gap, d.gap, 2.6, delta);
    c.bright = damp(c.bright, d.bright, 4, delta);
    c.alpha = d.snap ? d.alpha : damp(c.alpha, d.alpha, 4, delta);
    c.tag = damp(c.tag, d.tag, 5, delta);

    left.current.position.x = -(HALF_W + c.gap) / 2;
    right.current.position.x = (HALF_W + c.gap) / 2;

    const lit = c.alpha * c.bright;
    mats.bodyL.opacity = mats.bodyR.opacity = 0.62 * c.alpha;
    mats.faceL.opacity = mats.faceR.opacity = Math.min(1, 0.7 * lit);
    mats.edgeL.opacity = Math.min(1, 0.8 * lit);
    mats.edgeR.opacity = Math.min(1, (d.sealed ? 0.75 + 0.25 * Math.sin(t * 2.4) : 0.85) * lit);
    mats.tag.opacity = c.tag * c.alpha;
    mats.glow.opacity = 0.1 * lit;
    mats.strand.opacity = mats.broken.opacity = Math.min(1, lit);

    // each link is two stubs: whole ones meet in the middle, broken ones stop short and turn red
    for (let i = 0; i < STRANDS; i++) {
      const whole = i >= brokenCount;
      const len = Math.max(c.gap * (whole ? 0.5 : 0.24), 0.0001);
      const a = stubs.current[i * 2];
      const b = stubs.current[i * 2 + 1];
      if (!a || !b) continue;
      a.scale.x = b.scale.x = len;
      a.position.x = -c.gap / 2 + len / 2;
      b.position.x = c.gap / 2 - len / 2;
    }

    mats.seal.opacity = d.sealed ? (0.35 + 0.25 * Math.sin(t * 2.4)) * lit : 0;
    seal.current.rotation.z += delta * 0.25;
    if (d.shock >= 0 && d.shock < 1.3) {
      shock.current.scale.setScalar(0.6 + d.shock * 6.5);
      mats.shock.opacity = (1 - d.shock / 1.3) * 0.85 * c.alpha;
    } else mats.shock.opacity = 0;
  });

  return (
    <group ref={group} position={[0, -6, -10]}>
      <mesh position={[0, 0, -0.6]} scale={[3.6, 3.6, 1]} material={mats.glow}>
        <planeGeometry />
      </mesh>
      <group ref={left}>
        <mesh geometry={geo.box} material={mats.bodyL} />
        <lineSegments geometry={geo.edges} material={mats.edgeL} />
        <mesh geometry={geo.face} material={mats.faceL} position={[0, 0, DEPTH / 2 + 0.003]} />
      </group>
      <group ref={right}>
        <mesh geometry={geo.box} material={mats.bodyR} />
        <lineSegments geometry={geo.edges} material={mats.edgeR} />
        <mesh geometry={geo.face} material={mats.faceR} position={[0, 0, DEPTH / 2 + 0.003]} />
      </group>
      {Array.from({ length: STRANDS * 2 }, (_, k) => {
        const i = Math.floor(k / 2);
        return (
          <mesh
            key={k}
            ref={(m) => {
              if (m) stubs.current[k] = m;
            }}
            geometry={geo.stub}
            material={i >= brokenCount ? mats.strand : mats.broken}
            position={[0, SLAB_H * (0.42 - (i / (STRANDS - 1)) * 0.84), 0]}
          />
        );
      })}
      <mesh position={[0, SLAB_H / 2 + 0.42, 0]} material={mats.tag}>
        <planeGeometry args={[1.5, 0.44]} />
      </mesh>
      <mesh ref={seal} material={mats.seal}>
        <torusGeometry args={[1.62, 0.008, 6, 96]} />
      </mesh>
      <mesh ref={shock} material={mats.shock}>
        <ringGeometry args={[0.97, 1, 96]} />
      </mesh>
    </group>
  );
}

const gapOf = (s: StageSlab) => 0.04 + s.mismatch * 0.62;

// ---------------------------------------------------------------------------------------------
// The flow: demo orders arriving at the gate on a loop (gate mode, and the story's first and last steps)
// ---------------------------------------------------------------------------------------------

const DEMO: StageSlab[] = [
  {
    id: "demo-hub",
    label: "HUB $34.98",
    status: "captured",
    tone: "capture",
    mismatch: 0,
    flags: 0,
  },
  {
    id: "demo-ear",
    label: "EARBUDS+CARE",
    status: "voided",
    tone: "void",
    mismatch: 0.8,
    flags: 2,
  },
  {
    id: "demo-std",
    label: "STAND $41.00",
    status: "captured",
    tone: "capture",
    mismatch: 0,
    flags: 0,
  },
  {
    id: "demo-rnw",
    label: "HUB RENEWED",
    status: "ask human",
    tone: "ask",
    mismatch: 0.4,
    flags: 1,
  },
  { id: "demo-inj", label: "HUB $27.99", status: "voided", tone: "void", mismatch: 0.7, flags: 3 },
];
const CYCLE = 17;
const START = -9;
const END = 6.5;
const STOP = -1.35; // where a refused order stops, just short of the gate

function FlowSlab({ slab, index }: { slab: StageSlab; index: number }) {
  const drive = (t: number, narrow: boolean): SlabDrive => {
    const visible =
      stage.mode === "gate" || (stage.mode === "story" && (stage.story === 0 || stage.story >= 5));
    const u = ((((t + (index * CYCLE) / DEMO.length) % CYCLE) + CYCLE) % CYCLE) / CYCLE;
    let s = START + u * (END - START);
    const refused = slab.tone !== "capture";
    const arriveU = (STOP - START) / (END - START);
    let shock = -1;
    let gap = 0.04;
    let alpha = THREE.MathUtils.smoothstep(u, 0.04, 0.3);
    if (refused && s >= STOP) {
      s = STOP;
      const held = (u - arriveU) * CYCLE;
      gap = gapOf(slab) * Math.min(1, held / 0.8);
      if (slab.tone === "void") {
        shock = held;
        if (held < 0.25 && visible) gate.pulse = Math.min(gate.pulse, -1);
      }
      alpha *= 1 - THREE.MathUtils.smoothstep(held, 4.5, 6);
    } else if (!refused) {
      if (Math.abs(s) < 0.35 && visible) gate.pulse = Math.max(gate.pulse, 1);
      alpha *= 1 - THREE.MathUtils.smoothstep(s, 4, END);
    }
    const p = gate.pos.clone().addScaledVector(DIR, s * gate.scale);
    return {
      x: p.x,
      y: p.y + Math.sin(t * 0.7 + index) * 0.04,
      z: p.z,
      ry: -0.35 + input.px * 0.1,
      scale: (narrow ? 0.42 : 0.62) * gate.scale,
      gap,
      bright: 1,
      alpha: visible ? alpha : 0,
      tag: 0.9,
      sealed: refused && slab.tone === "void" && s === STOP,
      shock,
      snap: true,
    };
  };
  return <Slab slab={slab} drive={drive} />;
}

// ---------------------------------------------------------------------------------------------
// The story's own order (home page): intact, split, read by the gate, voided.
// ---------------------------------------------------------------------------------------------

const STORY_STATUS = ["", "agent checkout", "doesn't match", "re-reading", "voided", ""];

function StorySlab() {
  const step = stage.story;
  const slab: StageSlab = {
    id: "story-4471",
    label: "ORDER 4471",
    status: STORY_STATUS[step] ?? "",
    tone: step >= 4 ? "void" : step >= 2 ? "ask" : "idle",
    mismatch: step >= 2 ? 0.75 : 0,
    flags: step >= 2 ? 3 : 0,
  };
  const drive = (_t: number, narrow: boolean): SlabDrive => {
    const st = stage.story;
    const shown = st >= 1 && st <= 4;
    const front = gate.pos.clone().addScaledVector(DIR, (st >= 3 ? -0.2 : -2.6) * gate.scale);
    return {
      x: narrow ? 0 : front.x - (st >= 3 ? 0 : 0.6),
      y: narrow ? (st >= 3 ? 1.2 : 1.4) : front.y,
      z: front.z + (st >= 3 ? 0.4 : 1.2),
      ry: -0.42 + input.px * 0.16,
      scale: narrow ? 0.55 : st >= 3 ? 0.95 : 1.1,
      gap: st >= 2 ? gapOf(slab) : 0.04,
      bright: shown ? 1.2 : 0,
      alpha: shown ? 1 : 0,
      tag: shown ? 1 : 0,
      sealed: st === 4,
      shock: st === 4 ? since(stage.haltAt) : -1,
    };
  };
  return <Slab slab={slab} drive={drive} />;
}

// ---------------------------------------------------------------------------------------------
// Real orders: a row (the ledger) or one brought forward (verify, a live verdict)
// ---------------------------------------------------------------------------------------------

function DataSlab({ slab, index, count }: { slab: StageSlab; index: number; count: number }) {
  const drive = (t: number, narrow: boolean, aspect: number): SlabDrive => {
    const focused = stage.mode === "focus" && stage.focus === slab.id;
    const docket = stage.mode === "docket";
    const s = Math.min(input.scroll, 1.4);
    if (focused) {
      const p = gate.pos.clone().addScaledVector(new THREE.Vector3(0, 0, 1), 2.2 * gate.scale);
      return {
        x: narrow ? 0 : p.x - 0.2,
        y: (narrow ? 1.75 : p.y) + s * 2.4,
        z: narrow ? 0 : p.z,
        ry: -0.45 + input.px * 0.18,
        scale: narrow ? Math.min(0.62, (6.2 * aspect) / 4.4) : 0.92,
        gap: gapOf(slab),
        bright: 1.25 * (1 - 0.8 * Math.min(s, 1)),
        alpha: 1,
        tag: 1,
        sealed: slab.tone === "void",
        shock: since(stage.haltAt),
      };
    }
    if (docket) {
      const across = 6.2 * aspect;
      const mid = (count - 1) / 2;
      const spacing = Math.min(2.3, (across * 0.82) / Math.max(count - 1, 1), across * 0.36);
      const x = (index - mid) * spacing;
      const hovered = stage.hover === slab.id;
      return {
        x,
        y: -0.95 + (hovered ? 0.22 : 0) + Math.sin(t * 0.6 + index * 1.7) * 0.05,
        z: -Math.abs(index - mid) * 0.45,
        ry: -x * 0.09 + input.px * 0.14,
        scale: Math.min(0.92, spacing / 1.9),
        gap: 0.03 + slab.mismatch * 0.16,
        bright: hovered ? 1.7 : 1,
        alpha: 1 - 0.92 * THREE.MathUtils.smoothstep(s, 0.45, 1.1),
        tag: 1,
        sealed: slab.tone === "void",
        shock: -1,
      };
    }
    return {
      x: (index - count / 2) * 2,
      y: -1.7,
      z: -9,
      ry: 0,
      scale: 0.6,
      gap: 0.03,
      bright: 0.3,
      alpha: 0,
      tag: 0,
      sealed: false,
      shock: -1,
    };
  };
  return <Slab slab={slab} drive={drive} />;
}

// ---------------------------------------------------------------------------------------------
// The arena: evolved attacks circling the gate. Red = fooled POI-immune, amber = fooled only
// POI-static, ice = caught.
// ---------------------------------------------------------------------------------------------

function Swarm() {
  const N = 48;
  const mesh = useRef<THREE.InstancedMesh>(null!);
  const seeds = useMemo(
    () =>
      Array.from({ length: N }, (_, i) => ({
        r: 2.55 + ((i * 37) % 23) / 10,
        w: 0.12 + ((i * 13) % 17) / 60,
        phase: (i / N) * Math.PI * 2 * 3.7,
        tilt: (((i * 29) % 19) / 19 - 0.5) * 0.9,
        spin: ((i * 7) % 11) / 5 - 1,
      })),
    [],
  );
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const geo = useMemo(() => new THREE.BoxGeometry(0.15, 0.24, 0.012), []);
  const mat = useMemo(
    () => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.9 }),
    [],
  );
  useEffect(
    () => () => {
      geo.dispose();
      mat.dispose();
    },
    [geo, mat],
  );
  const visible = useRef(0);
  const last = useRef("");

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    visible.current = damp(visible.current, stage.mode === "swarm" ? 1 : 0, 2, delta);
    const sw = stage.swarm;
    const key = `${sw.fooledStatic.toFixed(2)}|${sw.fooledImmune.toFixed(2)}`;
    const show = Math.round(Math.min(N, Math.max(8, sw.count)));
    if (key !== last.current) {
      last.current = key;
      for (let i = 0; i < N; i++) {
        const f = i / N;
        color.copy(f < sw.fooledImmune ? RED : f < sw.fooledStatic ? AMBER : ICE);
        mesh.current.setColorAt(i, color);
      }
      if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
    }
    mat.opacity = 0.9 * visible.current;
    const rot = new THREE.Euler(0, GATE_YAW, 0);
    for (let i = 0; i < N; i++) {
      const s = seeds[i]!;
      const a = s.phase + t * s.w;
      const local = new THREE.Vector3(
        Math.cos(a) * s.r,
        Math.sin(a) * s.r * 0.85,
        Math.sin(a * 2 + s.phase) * s.tilt,
      );
      local.applyEuler(rot).multiplyScalar(gate.scale);
      dummy.position.copy(gate.pos).add(local);
      dummy.rotation.set(t * s.spin * 0.6, t * s.spin + i, a);
      dummy.scale.setScalar(i < show ? visible.current : 0);
      dummy.updateMatrix();
      mesh.current.setMatrixAt(i, dummy.matrix);
    }
    mesh.current.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={mesh} args={[geo, mat, N]} frustumCulled={false} />;
}

// ---------------------------------------------------------------------------------------------
// Immune memory: one glass crystal per antibody, orbiting the gate.
// ---------------------------------------------------------------------------------------------

function Crystal({
  index,
  total,
  kind,
}: {
  index: number;
  total: number;
  kind: "active" | "candidate" | "retired";
}) {
  const group = useRef<THREE.Group>(null!);
  const geo = useMemo(() => new THREE.OctahedronGeometry(0.2, 0), []);
  const edges = useMemo(() => new THREE.EdgesGeometry(geo), [geo]);
  const hue = kind === "active" ? ICE : kind === "candidate" ? AMBER : new THREE.Color("#5a6e80");
  const mats = useMemo(
    () => ({
      body: new THREE.MeshPhysicalMaterial({
        color: "#0a1826",
        metalness: 0.6,
        roughness: 0.12,
        clearcoat: 1,
        emissive: hue.clone(),
        emissiveIntensity: kind === "retired" ? 0.05 : 0.35,
        transparent: true,
        opacity: 0.85,
      }),
      edge: new THREE.LineBasicMaterial({
        color: hue.clone(),
        transparent: true,
        toneMapped: false,
      }),
    }),
    [hue, kind],
  );
  useEffect(
    () => () => {
      geo.dispose();
      edges.dispose();
      mats.body.dispose();
      mats.edge.dispose();
    },
    [geo, edges, mats],
  );
  const vis = useRef(0);
  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    vis.current = damp(vis.current, stage.mode === "crystals" ? 1 : 0, 2, delta);
    const a = (index / Math.max(total, 1)) * Math.PI * 2 + t * 0.12;
    const r = 2.9 + (index % 3) * 0.28;
    const local = new THREE.Vector3(
      Math.cos(a) * r,
      Math.sin(a) * r * 0.82,
      Math.sin(a * 3 + index) * 0.25,
    );
    local.applyEuler(new THREE.Euler(0, GATE_YAW, 0)).multiplyScalar(gate.scale);
    const g = group.current;
    g.position.copy(gate.pos).add(local);
    g.rotation.set(t * 0.4 + index, t * 0.6, 0);
    const pop =
      kind === "candidate" ? 0.75 + 0.15 * Math.sin(t * 3 + index) : kind === "retired" ? 0.6 : 1;
    g.scale.setScalar(vis.current * pop * gate.scale * 1.1);
    mats.edge.opacity = (kind === "retired" ? 0.35 : 0.95) * vis.current;
    mats.body.opacity = 0.85 * vis.current;
  });
  return (
    <group ref={group}>
      <mesh geometry={geo} material={mats.body} />
      <lineSegments geometry={edges} material={mats.edge} />
    </group>
  );
}

function Crystals() {
  useStageVersion();
  const { active, candidate, retired } = stage.crystals;
  const list: Array<"active" | "candidate" | "retired"> = [
    ...Array<"active">(Math.min(active, 18)).fill("active"),
    ...Array<"candidate">(Math.min(candidate, 6)).fill("candidate"),
    ...Array<"retired">(Math.min(retired, 6)).fill("retired"),
  ];
  return (
    <>
      {list.map((kind, i) => (
        <Crystal key={`${kind}-${i}`} index={i} total={list.length} kind={kind} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The room: ice dust, a floor of light, the camera, and the lens
// ---------------------------------------------------------------------------------------------

function Dust({ count }: { count: number }) {
  const mat = useRef<THREE.ShaderMaterial>(null!);
  const geometry = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 26;
      positions[i * 3 + 1] = Math.random() * 12 - 5;
      positions[i * 3 + 2] = Math.random() * 20 - 14;
      seeds[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    return g;
  }, [count]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uPixel: { value: 10 },
      uHalt: { value: 0 },
      uIce: { value: ICE },
      uRed: { value: RED },
    }),
    [],
  );
  useFrame((state, delta) => {
    const u = mat.current.uniforms;
    u.uTime!.value = state.clock.elapsedTime;
    u.uPixel!.value = state.size.height * state.viewport.dpr * 0.011;
    u.uHalt!.value = damp(u.uHalt!.value as number, halting() ? 0.55 : 0, 2, delta);
  });
  return (
    <points geometry={geometry} frustumCulled={false}>
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        vertexShader={`
          attribute float aSeed;
          uniform float uTime;
          uniform float uPixel;
          varying float vAlpha;
          void main() {
            vec3 p = position;
            p.y = mod(p.y + uTime * (0.05 + aSeed * 0.12) + 5.0, 12.0) - 5.0;
            p.x += sin(uTime * 0.2 + aSeed * 40.0) * 0.18;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = uPixel * (1.2 + aSeed * 2.6) / -mv.z;
            vAlpha = 0.2 + aSeed * 0.6;
          }
        `}
        fragmentShader={`
          uniform vec3 uIce;
          uniform vec3 uRed;
          uniform float uHalt;
          varying float vAlpha;
          void main() {
            float d = length(gl_PointCoord - 0.5);
            float a = smoothstep(0.5, 0.0, d) * vAlpha;
            gl_FragColor = vec4(mix(uIce, uRed, uHalt), a);
          }
        `}
      />
    </points>
  );
}

function Floor() {
  const uniforms = useMemo(() => ({ uColor: { value: ICE }, uDim: { value: 1 } }), []);
  useFrame((_, delta) => {
    uniforms.uDim.value = damp(uniforms.uDim.value, 1 - 0.6 * Math.min(input.scroll, 1), 3, delta);
  });
  return (
    <mesh rotation-x={-Math.PI / 2} position={[0, -2.62, -4]}>
      <planeGeometry args={[70, 70]} />
      <shaderMaterial
        uniforms={uniforms}
        transparent
        depthWrite={false}
        vertexShader={`
          varying vec3 vWorld;
          void main() {
            vec4 w = modelMatrix * vec4(position, 1.0);
            vWorld = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }
        `}
        fragmentShader={`
          uniform vec3 uColor;
          uniform float uDim;
          varying vec3 vWorld;
          void main() {
            vec2 c = vWorld.xz / 1.3;
            vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
            float line = 1.0 - min(min(g.x, g.y), 1.0);
            float fade = smoothstep(24.0, 3.0, length(vWorld.xz - vec2(0.0, 2.0)));
            gl_FragColor = vec4(uColor, line * fade * 0.28 * uDim);
          }
        `}
      />
    </mesh>
  );
}

function CameraRig() {
  useFrame((state, delta) => {
    const cam = state.camera;
    const p = Math.min(input.scroll, 1.1);
    const story = stage.mode === "story";
    const docket = stage.mode === "docket";
    const settle = stage.mode === "focus" || stage.mode === "gate";
    cam.position.x = damp(cam.position.x, input.px * 0.35, 2.5, delta);
    cam.position.y = damp(
      cam.position.y,
      (settle || story ? 0.2 : 0.2 - p * (docket ? 2.1 : 1.2)) - input.py * 0.15,
      2.5,
      delta,
    );
    cam.position.z = damp(
      cam.position.z,
      story ? 9 - 0.25 * stage.story : settle ? 9 : 9 - p * 2,
      2.5,
      delta,
    );
    cam.lookAt(cam.position.x * 0.4, cam.position.y, 0);
  });
  return null;
}

/** Bloom, grain and vignette, with a colour-split kick on every scene change and on a VOID. */
function Effects() {
  const offset = useMemo(() => new THREE.Vector2(0.0005, 0.0003), []);
  const kick = useRef(0);
  const last = useRef(`${stage.mode}|${stage.focus}|${stage.story}`);
  useFrame((_, delta) => {
    const key = `${stage.mode}|${stage.focus}|${stage.story}`;
    if (key !== last.current) kick.current = 0.8;
    last.current = key;
    const age = since(stage.haltAt);
    if (age < 0.25) kick.current = 1.6;
    kick.current = damp(kick.current, 0, 4.5, delta);
    const v = 0.0005 + kick.current * 0.006;
    offset.set(v, v * 0.6);
  });
  return (
    <EffectComposer multisampling={0}>
      <Bloom mipmapBlur intensity={0.85} luminanceThreshold={0.5} luminanceSmoothing={0.25} />
      <ChromaticAberration offset={offset} radialModulation={false} modulationOffset={0} />
      <Noise opacity={0.04} />
      <Vignette eskil={false} offset={0.25} darkness={0.8} />
    </EffectComposer>
  );
}

function Scene({ effects, dust }: { effects: boolean; dust: number }) {
  useStageVersion();
  const slabs = stage.slabs.slice(0, 9);
  const flow = stage.mode === "gate" || stage.mode === "story";
  return (
    <>
      <color attach="background" args={["#03050a"]} />
      <fog attach="fog" args={["#03050a", 9, 26]} />
      <ambientLight intensity={0.3} />
      <directionalLight position={[3, 4, 5]} intensity={1.1} color="#dff6ff" />
      <pointLight position={[-4, 1, 3]} intensity={8} color="#4fc3f0" distance={14} />
      <Environment resolution={128} frames={1}>
        <Lightformer
          intensity={2.2}
          rotation-x={Math.PI / 2}
          position={[0, 4, -6]}
          scale={[10, 1, 1]}
        />
        <Lightformer
          intensity={2.4}
          rotation-y={Math.PI / 2}
          position={[-5, 1, -1]}
          scale={[20, 0.3, 1]}
          color="#9be7ff"
        />
        <Lightformer
          intensity={1.6}
          rotation-y={-Math.PI / 2}
          position={[5, -1, 0]}
          scale={[20, 0.5, 1]}
          color="#4fc3f0"
        />
      </Environment>
      <CameraRig />
      <Dust count={dust} />
      <Floor />
      <Gate />
      {flow && DEMO.map((s, i) => <FlowSlab key={s.id} slab={s} index={i} />)}
      {stage.mode === "story" && <StorySlab />}
      {(stage.mode === "docket" || stage.mode === "focus") &&
        slabs.map((s, i) => <DataSlab key={s.id} slab={s} index={i} count={slabs.length} />)}
      <Swarm />
      <Crystals />
      {effects && <Effects />}
    </>
  );
}

export default function StageCanvas() {
  useWindowInput();
  useStageVersion();
  // 0 = full, 1 = lower resolution, 2 = lower resolution and no post-processing (set when frames drop)
  const [tier, setTier] = useState(0);
  const [small, setSmall] = useState(false);
  useEffect(() => {
    const check = () => setSmall(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  const level = Math.max(tier, small ? 1 : 0);

  return (
    <Canvas
      dpr={level === 0 ? [1, 1.25] : level === 1 ? 1 : 0.8}
      frameloop={stage.paused ? "never" : "always"}
      camera={{ position: [0, 0.2, 9], fov: 38, near: 0.1, far: 60 }}
      gl={{ antialias: false, powerPreference: "high-performance", stencil: false, alpha: false }}
      style={{ pointerEvents: "none" }}
    >
      <PerformanceMonitor flipflops={2} onDecline={() => setTier((t) => Math.min(t + 1, 2))}>
        <Scene effects={level < 2} dust={small ? 500 : 1100} />
      </PerformanceMonitor>
    </Canvas>
  );
}
